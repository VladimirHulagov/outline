import { z } from "zod";
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Document, Revision } from "@server/models";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import { authorize } from "@server/policies";
import parseTitle from "@shared/utils/parseTitle";
import presentUser from "@server/presenters/user";
import AuthenticationHelper from "@shared/helpers/AuthenticationHelper";
import {
  error,
  success,
  getActorFromContext,
  validateDocumentId,
  withTracing,
} from "./util";

export function revisionTools(server: McpServer, scopes: string[]) {
  if (AuthenticationHelper.canAccess("documents.read", scopes)) {
    server.registerTool(
      "list_revisions",
      {
        title: "List document revisions",
        description:
          "Returns the revision history of a document. Each revision represents a saved snapshot of the document at a point in time, including who made the change and when. Use get_revision to retrieve the full content of a specific revision.",
        annotations: {
          idempotentHint: true,
          readOnlyHint: true,
        },
        inputSchema: {
          documentId: z
            .string()
            .describe(
              "The document ID to list revisions for. Accepts a full UUID or a urlId from the document URL."
            ),
          limit: z.coerce
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe(
              "Maximum number of revisions to return. Defaults to 25, max 100."
            ),
          offset: z.coerce
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Pagination offset. Defaults to 0."),
          direction: z
            .enum(["ASC", "DESC"])
            .optional()
            .describe(
              "Sort direction by creation time. Defaults to DESC (newest first)."
            ),
        },
      },
      withTracing(
        "list_revisions",
        async ({ documentId, limit, offset, direction }, extra) => {
          try {
            const idError = validateDocumentId(documentId);
            if (idError) {
              return idError;
            }

            const user = getActorFromContext(extra);
            const document = await Document.findByPk(documentId, {
              userId: user.id,
              paranoid: false,
            });
            authorize(user, "listRevisions", document);

            const revisions = await Revision.findAll({
              where: { documentId: document.id },
              order: [["createdAt", direction ?? "DESC"]],
              offset: offset ?? 0,
              limit: limit ?? 25,
              paranoid: false,
            });

            const presented = await Promise.all(
              revisions.map(async (revision) => {
                const { strippedTitle } = parseTitle(revision.title);
                const collaborators = await revision.collaborators;
                return {
                  id: revision.id,
                  documentId: revision.documentId,
                  title: strippedTitle,
                  name: revision.name,
                  icon: revision.icon,
                  color: revision.color,
                  createdAt: revision.createdAt,
                  createdById: revision.userId,
                  createdBy: presentUser(revision.user),
                  collaborators: collaborators.map((u) => presentUser(u)),
                };
              })
            );

            return success(presented);
          } catch (message) {
            return error(message);
          }
        }
      )
    );

    server.registerTool(
      "get_revision",
      {
        title: "Get revision",
        description:
          "Retrieves a specific revision by its ID. Returns revision metadata and optionally the full markdown content. Use list_revisions first to find the revision ID you need.",
        annotations: {
          idempotentHint: true,
          readOnlyHint: true,
        },
        inputSchema: {
          id: z.string().describe("The unique identifier of the revision."),
          includeText: z
            .boolean()
            .optional()
            .describe(
              "Whether to include the full markdown content of the revision. Defaults to false to avoid flooding the context window."
            ),
        },
      },
      withTracing("get_revision", async ({ id, includeText }, extra) => {
        try {
          const user = getActorFromContext(extra);
          const wantText = includeText ?? false;

          const revision = await Revision.findByPk(id, {
            rejectOnEmpty: true,
          });

          const document = await Document.findByPk(revision.documentId, {
            userId: user.id,
          });
          authorize(user, "listRevisions", document);

          const { strippedTitle } = parseTitle(revision.title);
          const collaborators = await revision.collaborators;

          const attributes: Record<string, unknown> = {
            id: revision.id,
            documentId: revision.documentId,
            title: strippedTitle,
            name: revision.name,
            icon: revision.icon,
            color: revision.color,
            createdAt: revision.createdAt,
            createdById: revision.userId,
            createdBy: presentUser(revision.user),
            collaborators: collaborators.map((u) => presentUser(u)),
          };

          const content: CallToolResult["content"] = [
            {
              type: "text" as const,
              text: JSON.stringify(attributes),
            },
          ];

          if (wantText) {
            const text = await DocumentHelper.toMarkdown(revision);
            content.push({
              type: "text" as const,
              text: String(text ?? ""),
            });
          }

          return { content } satisfies CallToolResult;
        } catch (message) {
          return error(message);
        }
      })
    );
  }
}
