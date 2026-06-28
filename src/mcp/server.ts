import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { TransactionToolService } from "../services/transaction-tool-service.js";

function toToolResponse(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

export function createMcpServer(
  toolService: TransactionToolService,
  notifyActivity: () => void,
): McpServer {
  const server = new McpServer({
    name: "quicken-simplifi-mcp",
    version: "0.1.0",
  });
  const mcp = server as any;

  function tool(name: string, description: string, schema: object, handler: (input: any) => Promise<unknown>) {
    mcp.tool(name, description, schema, async (input: any) => {
      notifyActivity();
      return toToolResponse(await handler(input));
    });
  }

  tool(
    "list_transactions",
    "List locally cached Simplifi transactions with optional filters and pagination.",
    {
      limit: z.coerce.number().int().min(1).max(200).optional(),
      cursor: z.string().optional(),
      accountId: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      minAmount: z.number().optional(),
      maxAmount: z.number().optional(),
      includeDeleted: z.boolean().optional(),
      refresh: z.boolean().optional(),
    },
    (input) => toolService.listTransactions(input),
  );

  tool(
    "search_transactions",
    "Search locally cached Simplifi transactions by text with optional filters.",
    {
      query: z.string().min(1),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      cursor: z.string().optional(),
      accountId: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      minAmount: z.number().optional(),
      maxAmount: z.number().optional(),
      includeDeleted: z.boolean().optional(),
      refresh: z.boolean().optional(),
    },
    (input) => toolService.searchTransactions(input),
  );

  tool(
    "get_transaction",
    "Get a single transaction by id from local cache (with sync-on-miss).",
    {
      transactionId: z.string().min(1),
      refreshOnMiss: z.boolean().optional(),
    },
    (input) => toolService.getTransaction(input),
  );

  tool(
    "update_transaction",
    "Update a Simplifi transaction by sending a full upsert payload merged from cache + patch.",
    {
      transactionId: z.string().min(1),
      patch: z.preprocess((v) => (typeof v === "string" ? JSON.parse(v) : v), z.record(z.any())),
    },
    (input) => toolService.updateTransaction(input),
  );

  tool(
    "categorize_transaction",
    "Convenience wrapper to set a transaction category (sets coa.type=CATEGORY and coa.id=<categoryId>).",
    {
      transactionId: z.string().min(1),
      categoryId: z.string().min(1),
    },
    (input) => toolService.categorizeTransaction(input),
  );

  tool(
    "list_uncategorized_transactions",
    "List transactions that look uncategorized (coa.type=UNCATEGORIZED or coa.id=0).",
    {
      limit: z.coerce.number().int().min(1).max(200).optional(),
      cursor: z.string().optional(),
      accountId: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      minAmount: z.number().optional(),
      maxAmount: z.number().optional(),
      includeDeleted: z.boolean().optional(),
      refresh: z.boolean().optional(),
    },
    (input) => toolService.listUncategorizedTransactions(input),
  );

  tool(
    "search_merchants",
    "Search merchants (payee names) from the cached transaction DB and return frequency counts.",
    {
      query: z.string().min(1),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      includeDeleted: z.boolean().optional(),
    },
    (input) => toolService.searchMerchants(input),
  );

  tool(
    "list_categories",
    "List Simplifi categories (synced and cached locally).",
    {
      refresh: z.boolean().optional(),
      limit: z.coerce.number().int().min(1).max(5000).optional(),
    },
    (input) => toolService.listCategories(input),
  );

  tool(
    "search_categories",
    "Search Simplifi categories by name (synced and cached locally).",
    {
      query: z.string().min(1),
      refresh: z.boolean().optional(),
      limit: z.coerce.number().int().min(1).max(5000).optional(),
    },
    (input) => toolService.searchCategories(input),
  );

  tool(
    "create_tag",
    "Create a new tag in Simplifi and add it to the local cache.",
    {
      name: z.string().min(1),
    },
    (input) => toolService.createTag(input),
  );

  tool(
    "list_tags",
    "List Simplifi tags (synced and cached locally).",
    {
      refresh: z.boolean().optional(),
      limit: z.coerce.number().int().min(1).max(5000).optional(),
    },
    (input) => toolService.listTags(input),
  );

  tool(
    "search_tags",
    "Search Simplifi tags by name (synced and cached locally).",
    {
      query: z.string().min(1),
      refresh: z.boolean().optional(),
      limit: z.coerce.number().int().min(1).max(5000).optional(),
    },
    (input) => toolService.searchTags(input),
  );

  tool(
    "tag_transaction",
    "Add one or more tags to a transaction (merges with existing tags, does not remove others).",
    {
      transactionId: z.string().min(1),
      tagIds: z.array(z.string().min(1)).min(1),
    },
    (input) => toolService.tagTransaction(input),
  );

  tool(
    "untag_transaction",
    "Remove one or more tags from a transaction by their tag IDs.",
    {
      transactionId: z.string().min(1),
      tagIds: z.array(z.string().min(1)).min(1),
    },
    (input) => toolService.untagTransaction(input),
  );

  tool(
    "set_transaction_tags",
    "Replace all tags on a transaction with exactly the provided tag IDs (overwrites existing tags).",
    {
      transactionId: z.string().min(1),
      tagIds: z.array(z.string()),
    },
    (input) => toolService.setTransactionTags(input),
  );

  tool(
    "set_transaction_memo",
    "Set the memo/note text on a transaction. Pass an empty string to clear the memo.",
    {
      transactionId: z.string().min(1),
      memo: z.string(),
    },
    (input) => toolService.setTransactionMemo(input),
  );

  tool(
    "list_transactions_by_tag",
    "List transactions that have a specific tag applied, identified by tagId or tagName.",
    {
      tagId: z.string().optional(),
      tagName: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      cursor: z.string().optional(),
      accountId: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      minAmount: z.number().optional(),
      maxAmount: z.number().optional(),
      includeDeleted: z.boolean().optional(),
      refresh: z.boolean().optional(),
    },
    (input) => toolService.listTransactionsByTag(input),
  );

  tool(
    "suggest_categories_for_merchant",
    "Suggest likely categories for a merchant based on your historical transactions in the local cache.",
    {
      merchant: z.string().min(1),
      limit: z.coerce.number().int().min(1).max(20).optional(),
      matchMode: z.enum(["exact", "contains"]).optional(),
      refreshCategories: z.boolean().optional(),
    },
    (input) => toolService.suggestCategoriesForMerchant(input),
  );

  return server;
}
