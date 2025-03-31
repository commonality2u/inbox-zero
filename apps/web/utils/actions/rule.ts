"use server";

import { revalidatePath } from "next/cache";
import {
  createRuleBody,
  type CreateRuleBody,
  updateRuleBody,
  type UpdateRuleBody,
  updateRuleInstructionsBody,
  type UpdateRuleInstructionsBody,
  rulesExamplesBody,
  type RulesExamplesBody,
  updateRuleSettingsBody,
  type UpdateRuleSettingsBody,
  createRulesOnboardingBody,
  type CreateRulesOnboardingBody,
  enableDraftRepliesBody,
  type EnableDraftRepliesBody,
} from "@/utils/actions/rule.validation";
import { auth } from "@/app/api/auth/[...nextauth]/auth";
import prisma, { isDuplicateError, isNotFoundError } from "@/utils/prisma";
import { getGmailAccessToken, getGmailClient } from "@/utils/gmail/client";
import { aiFindExampleMatches } from "@/utils/ai/example-matches/find-example-matches";
import { withActionInstrumentation } from "@/utils/actions/middleware";
import { flattenConditions } from "@/utils/condition";
import { ActionType, ColdEmailSetting, LogicalOperator } from "@prisma/client";
import {
  updatePromptFileOnRuleUpdated,
  updateRuleInstructionsAndPromptFile,
  updatePromptFileOnRuleCreated,
} from "@/utils/rule/prompt-file";
import { generatePromptOnDeleteRule } from "@/utils/ai/rule/generate-prompt-on-delete-rule";
import { sanitizeActionFields } from "@/utils/action-item";
import { deleteRule } from "@/utils/rule/rule";
import { createScopedLogger } from "@/utils/logger";
import { SafeError } from "@/utils/error";
import { enableReplyTracker } from "@/utils/reply-tracker/enable";
import { env } from "@/env";
import { INTERNAL_API_KEY_HEADER } from "@/utils/internal-api";
import type { ProcessPreviousBody } from "@/app/api/reply-tracker/process-previous/route";
import { RuleName } from "@/utils/rule/consts";

const logger = createScopedLogger("actions/rule");

export const createRuleAction = withActionInstrumentation(
  "createRule",
  async (options: CreateRuleBody) => {
    const session = await auth();
    if (!session?.user.id) return { error: "Not logged in" };

    const { data: body, error } = createRuleBody.safeParse(options);
    if (error) return { error: error.message };

    const conditions = flattenConditions(body.conditions);

    try {
      const rule = await prisma.rule.create({
        data: {
          name: body.name || "",
          automate: body.automate ?? undefined,
          runOnThreads: body.runOnThreads ?? undefined,
          actions: body.actions
            ? {
                createMany: {
                  data: body.actions.map(
                    ({ type, label, subject, content, to, cc, bcc, url }) => {
                      return sanitizeActionFields({
                        type,
                        label: label?.value,
                        subject: subject?.value,
                        content: content?.value,
                        to: to?.value,
                        cc: cc?.value,
                        bcc: bcc?.value,
                        url: url?.value,
                      });
                    },
                  ),
                },
              }
            : undefined,
          userId: session.user.id,
          conditionalOperator: body.conditionalOperator || LogicalOperator.AND,
          // conditions
          instructions: conditions.instructions || null,
          from: conditions.from || null,
          to: conditions.to || null,
          subject: conditions.subject || null,
          // body: conditions.body || null,
          categoryFilterType: conditions.categoryFilterType || null,
          categoryFilters:
            conditions.categoryFilterType && conditions.categoryFilters
              ? {
                  connect: conditions.categoryFilters.map((id) => ({ id })),
                }
              : {},
        },
        include: { actions: true, categoryFilters: true, group: true },
      });

      await updatePromptFileOnRuleCreated(session.user.id, rule);

      revalidatePath("/automation");

      return { rule };
    } catch (error) {
      if (isDuplicateError(error, "name")) {
        return { error: "Rule name already exists" };
      }
      if (isDuplicateError(error, "groupId")) {
        return {
          error: "Group already has a rule. Please use the existing rule.",
        };
      }

      logger.error("Error creating rule", { error });
      throw new SafeError("Error creating rule");
    }
  },
);

export const updateRuleAction = withActionInstrumentation(
  "updateRule",
  async (options: UpdateRuleBody) => {
    const session = await auth();
    if (!session?.user.id) return { error: "Not logged in" };

    const { data: body, error } = updateRuleBody.safeParse(options);
    if (error) return { error: error.message };

    const conditions = flattenConditions(body.conditions);

    try {
      const currentRule = await prisma.rule.findUnique({
        where: { id: body.id, userId: session.user.id },
        include: { actions: true, categoryFilters: true, group: true },
      });
      if (!currentRule) return { error: "Rule not found" };

      const currentActions = currentRule.actions;

      const actionsToDelete = currentActions.filter(
        (currentAction) => !body.actions.find((a) => a.id === currentAction.id),
      );
      const actionsToUpdate = body.actions.filter((a) => a.id);
      const actionsToCreate = body.actions.filter((a) => !a.id);

      const [updatedRule] = await prisma.$transaction([
        // update rule
        prisma.rule.update({
          where: { id: body.id, userId: session.user.id },
          data: {
            automate: body.automate ?? undefined,
            runOnThreads: body.runOnThreads ?? undefined,
            name: body.name || undefined,
            conditionalOperator:
              body.conditionalOperator || LogicalOperator.AND,
            // conditions
            instructions: conditions.instructions || null,
            from: conditions.from || null,
            to: conditions.to || null,
            subject: conditions.subject || null,
            // body: conditions.body || null,
            categoryFilterType: conditions.categoryFilterType || null,
            categoryFilters:
              conditions.categoryFilterType && conditions.categoryFilters
                ? {
                    set: conditions.categoryFilters.map((id) => ({ id })),
                  }
                : { set: [] },
          },
          include: { actions: true, categoryFilters: true, group: true },
        }),
        // delete removed actions
        ...(actionsToDelete.length
          ? [
              prisma.action.deleteMany({
                where: { id: { in: actionsToDelete.map((a) => a.id) } },
              }),
            ]
          : []),
        // update existing actions
        ...actionsToUpdate.map((a) => {
          return prisma.action.update({
            where: { id: a.id },
            data: sanitizeActionFields({
              type: a.type,
              label: a.label?.value,
              subject: a.subject?.value,
              content: a.content?.value,
              to: a.to?.value,
              cc: a.cc?.value,
              bcc: a.bcc?.value,
              url: a.url?.value,
            }),
          });
        }),
        // create new actions
        ...(actionsToCreate.length
          ? [
              prisma.action.createMany({
                data: actionsToCreate.map((a) => {
                  return {
                    ...sanitizeActionFields({
                      type: a.type,
                      label: a.label?.value,
                      subject: a.subject?.value,
                      content: a.content?.value,
                      to: a.to?.value,
                      cc: a.cc?.value,
                      bcc: a.bcc?.value,
                      url: a.url?.value,
                    }),
                    ruleId: body.id,
                  };
                }),
              }),
            ]
          : []),
      ]);

      // update prompt file
      await updatePromptFileOnRuleUpdated(
        session.user.id,
        currentRule,
        updatedRule,
      );

      revalidatePath(`/automation/rule/${body.id}`);
      revalidatePath("/automation");

      return { rule: updatedRule };
    } catch (error) {
      if (isDuplicateError(error, "name")) {
        return { error: "Rule name already exists" };
      }
      if (isDuplicateError(error, "groupId")) {
        return {
          error: "Group already has a rule. Please use the existing rule.",
        };
      }

      logger.error("Error updating rule", { error });
      throw new SafeError("Error updating rule");
    }
  },
);

export const updateRuleInstructionsAction = withActionInstrumentation(
  "updateRuleInstructions",
  async (options: UpdateRuleInstructionsBody) => {
    const session = await auth();
    if (!session?.user.id) return { error: "Not logged in" };

    const { data: body, error } = updateRuleInstructionsBody.safeParse(options);
    if (error) return { error: error.message };

    const currentRule = await prisma.rule.findUnique({
      where: { id: body.id, userId: session.user.id },
      include: { actions: true, categoryFilters: true, group: true },
    });
    if (!currentRule) return { error: "Rule not found" };

    await updateRuleInstructionsAndPromptFile({
      userId: session.user.id,
      ruleId: body.id,
      instructions: body.instructions,
      currentRule,
    });

    revalidatePath(`/automation/rule/${body.id}`);
    revalidatePath("/automation");
  },
);

export const updateRuleSettingsAction = withActionInstrumentation(
  "updateRuleSettings",
  async (options: UpdateRuleSettingsBody) => {
    const session = await auth();
    if (!session?.user.id) return { error: "Not logged in" };

    const { data: body, error } = updateRuleSettingsBody.safeParse(options);
    if (error) return { error: error.message };

    await prisma.rule.update({
      where: { id: body.id, userId: session.user.id },
      data: {
        instructions: body.instructions,
        draftReplies: body.draftReplies,
        draftRepliesInstructions: body.draftRepliesInstructions,
      },
    });

    revalidatePath(`/automation/rule/${body.id}`);
    revalidatePath("/automation");
    revalidatePath("/reply-zero");
  },
);

export const enableDraftRepliesAction = withActionInstrumentation(
  "enableDraftReplies",
  async (options: EnableDraftRepliesBody) => {
    const session = await auth();
    if (!session?.user.id) return { error: "Not logged in" };

    const { data, error } = enableDraftRepliesBody.safeParse(options);
    if (error) return { error: error.message };

    const rule = await prisma.rule.findFirst({
      where: { userId: session.user.id, trackReplies: true },
    });
    if (!rule) return { error: "Rule not found" };

    await prisma.rule.update({
      where: { id: rule.id, userId: session.user.id },
      data: { draftReplies: data.enable },
    });

    revalidatePath(`/automation/rule/${rule.id}`);
    revalidatePath("/automation");
    revalidatePath("/reply-zero");
  },
);

export const deleteRuleAction = withActionInstrumentation(
  "deleteRule",
  async ({ ruleId }: { ruleId: string }) => {
    const session = await auth();
    if (!session?.user.id) return { error: "Not logged in" };

    const rule = await prisma.rule.findUnique({
      where: { id: ruleId },
      include: { actions: true, categoryFilters: true, group: true },
    });
    if (!rule) return; // already deleted
    if (rule.userId !== session.user.id)
      return { error: "You don't have permission to delete this rule" };

    try {
      await deleteRule({
        ruleId,
        userId: session.user.id,
        groupId: rule.groupId,
      });

      const user = await prisma.user.findUnique({
        where: { id: session.user.id },
        select: {
          email: true,
          aiModel: true,
          aiProvider: true,
          aiApiKey: true,
          rulesPrompt: true,
        },
      });
      if (!user) return { error: "User not found" };

      if (!user.rulesPrompt) return;

      const updatedPrompt = await generatePromptOnDeleteRule({
        user,
        existingPrompt: user.rulesPrompt,
        deletedRule: rule,
      });

      await prisma.user.update({
        where: { id: session.user.id },
        data: { rulesPrompt: updatedPrompt },
      });

      revalidatePath(`/automation/rule/${ruleId}`);
      revalidatePath("/automation");
    } catch (error) {
      if (isNotFoundError(error)) return;
      throw error;
    }
  },
);

export const getRuleExamplesAction = withActionInstrumentation(
  "getRuleExamples",
  async (unsafeData: RulesExamplesBody) => {
    const session = await auth();
    if (!session?.user.id) return { error: "Not logged in" };

    const { success, error, data } = rulesExamplesBody.safeParse(unsafeData);
    if (!success) return { error: error.message };

    const gmail = getGmailClient(session);
    const token = await getGmailAccessToken(session);

    if (!token.token) return { error: "No access token" };

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        email: true,
        aiModel: true,
        aiProvider: true,
        aiApiKey: true,
      },
    });
    if (!user) return { error: "User not found" };

    const { matches } = await aiFindExampleMatches(
      user,
      gmail,
      token.token,
      data.rulesPrompt,
    );

    return { matches };
  },
);

export const createRulesOnboardingAction = withActionInstrumentation(
  "createRulesOnboarding",
  async (options: CreateRulesOnboardingBody) => {
    const session = await auth();
    if (!session?.user.id) return { error: "Not logged in" };

    const { data, error } = createRulesOnboardingBody.safeParse(options);
    if (error) return { error: error.message };

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { rulesPrompt: true },
    });
    if (!user) return { error: "User not found" };

    const promises: Promise<any>[] = [];

    const isSet = (value: string): value is "label" | "label_archive" =>
      value !== "none";

    // cold email blocker
    if (isSet(data.coldEmails)) {
      const promise = prisma.user.update({
        where: { id: session.user.id },
        data: {
          coldEmailBlocker:
            data.coldEmails === "label"
              ? ColdEmailSetting.LABEL
              : ColdEmailSetting.ARCHIVE_AND_LABEL,
        },
      });
      promises.push(promise);
    }

    const rules: string[] = [];

    // reply tracker
    if (isSet(data.toReply)) {
      const promise = enableReplyTracker(session.user.id).then((res) => {
        if (res?.alreadyEnabled) return;

        // Load previous emails needing replies in background
        // This can take a while
        if (env.INTERNAL_API_KEY) {
          fetch(
            `${env.NEXT_PUBLIC_BASE_URL}/api/reply-tracker/process-previous`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                [INTERNAL_API_KEY_HEADER]: env.INTERNAL_API_KEY,
              },
              body: JSON.stringify({
                userId: session.user.id,
              } satisfies ProcessPreviousBody),
            },
          );
        }
      });
      promises.push(promise);
    }

    // regular categories
    async function createRule(
      name: string,
      instructions: string,
      promptFileInstructions: string,
      runOnThreads: boolean,
      categoryAction: "label" | "label_archive",
    ) {
      const existingRule = await prisma.rule.findUnique({
        where: { name_userId: { name, userId: session?.user.id! } },
      });

      if (existingRule) {
        const promise = prisma.rule.update({
          where: { id: existingRule.id },
          data: {
            instructions,
            actions: {
              deleteMany: {},
              createMany: {
                data: [
                  { type: ActionType.LABEL, label: "Newsletter" },
                  ...(categoryAction === "label_archive"
                    ? [{ type: ActionType.ARCHIVE }]
                    : []),
                ],
              },
            },
          },
        });
        promises.push(promise);

        // TODO: prompt file update
      } else {
        const promise = prisma.rule
          .create({
            data: {
              userId: session?.user.id!,
              name,
              instructions,
              automate: true,
              runOnThreads,
              actions: {
                createMany: {
                  data: [
                    { type: ActionType.LABEL, label: "Newsletter" },
                    ...(categoryAction === "label_archive"
                      ? [{ type: ActionType.ARCHIVE }]
                      : []),
                  ],
                },
              },
            },
          })
          .catch((error) => {
            if (isDuplicateError(error, "name")) return;
            throw error;
          });
        promises.push(promise);

        rules.push(
          `${promptFileInstructions}${
            categoryAction === "label_archive" ? " and archive them" : ""
          }.`,
        );
      }
    }

    // newsletters
    if (isSet(data.newsletters)) {
      createRule(
        RuleName.Newsletters,
        "Newsletters: Regular content from publications, blogs, or services I've subscribed to",
        "Label all newsletters as 'Newsletter'",
        false,
        data.newsletters,
      );
    }

    // marketing
    if (isSet(data.marketing)) {
      createRule(
        RuleName.Marketing,
        "Marketing: Promotional emails about products, services, sales, or offers",
        "Label all marketing emails as 'Marketing'",
        false,
        data.marketing,
      );
    }

    // calendar
    if (isSet(data.calendar)) {
      createRule(
        RuleName.Calendar,
        "Calendar: Any email related to scheduling, meeting invites, or calendar notifications",
        "Label all calendar emails as 'Calendar'",
        false,
        data.calendar,
      );
    }

    // receipts
    if (isSet(data.receipts)) {
      createRule(
        RuleName.Receipts,
        "Receipts: Purchase confirmations, payment receipts, transaction records or invoices",
        "Label all receipts as 'Receipts'",
        false,
        data.receipts,
      );
    }

    // notifications
    if (isSet(data.notifications)) {
      createRule(
        RuleName.Notifications,
        "Notifications: Alerts, status updates, or system messages",
        "Label all notifications as 'Notifications'",
        false,
        data.notifications,
      );
    }

    await Promise.allSettled(promises);

    await prisma.user.update({
      where: { id: session.user.id },
      data: {
        rulesPrompt:
          `${user.rulesPrompt || ""}\n${rules.map((r) => `* ${r}`).join("\n")}`.trim(),
      },
    });
  },
);
