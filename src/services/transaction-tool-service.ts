import { randomUUID } from "node:crypto";

import { DatabaseContext, type TransactionQuery } from "../db/database.js";
import type { Account, Tag, TagRef, Transaction, TransactionFilters } from "../types.js";
import { deepMerge } from "../utils.js";
import { SimplifiClient } from "../simplifi/client.js";
import { SyncService } from "../sync/sync-service.js";
import { ReferenceDataService } from "./reference-data-service.js";

export interface ListTransactionsInput extends TransactionFilters {
  limit?: number;
  cursor?: string;
  refresh?: boolean;
}

export interface SearchTransactionsInput extends TransactionFilters {
  query: string;
  limit?: number;
  cursor?: string;
  refresh?: boolean;
}

export interface GetTransactionInput {
  transactionId: string;
  refreshOnMiss?: boolean;
}

export interface UpdateTransactionInput {
  transactionId: string;
  patch: Record<string, unknown>;
}

export class TransactionToolService {
  public constructor(
    private readonly db: DatabaseContext,
    private readonly syncService: SyncService,
    private readonly simplifiClient: SimplifiClient,
    private readonly referenceDataService: ReferenceDataService,
    private readonly maxStaleMs: number,
  ) {}

  public async listTransactions(input: ListTransactionsInput): Promise<Record<string, unknown>> {
    await this.maybeRefresh(input.refresh ?? false);

    const page = this.db.listTransactions(this.toQuery(input));
    return {
      total: page.total,
      nextCursor: page.nextCursor,
      items: page.items,
    };
  }

  public async searchTransactions(input: SearchTransactionsInput): Promise<Record<string, unknown>> {
    await this.maybeRefresh(input.refresh ?? false);

    const page = this.db.searchTransactions({
      ...this.toQuery(input),
      searchTerm: input.query,
    });

    return {
      total: page.total,
      nextCursor: page.nextCursor,
      items: page.items,
    };
  }

  public async getTransaction(input: GetTransactionInput): Promise<Record<string, unknown>> {
    await this.syncService.ensureFresh(this.maxStaleMs);

    let transaction = this.db.getTransactionById(input.transactionId);
    if (!transaction && (input.refreshOnMiss ?? true)) {
      await this.syncService.syncIncremental();
      transaction = this.db.getTransactionById(input.transactionId);
    }

    if (!transaction) {
      throw new Error(`Transaction ${input.transactionId} not found in cache`);
    }

    return { transaction };
  }

  public async updateTransaction(input: UpdateTransactionInput): Promise<Record<string, unknown>> {
    await this.syncService.ensureFresh(this.maxStaleMs);

    const current = this.db.getTransactionById(input.transactionId);
    if (!current) {
      await this.syncService.syncIncremental();
    }

    const baseline = this.db.getTransactionById(input.transactionId);
    if (!baseline) {
      throw new Error(`Transaction ${input.transactionId} not found in cache; cannot update`);
    }

    const merged = deepMerge<Transaction>(baseline, input.patch);
    this.assertUpsertRequiredFields(merged);

    const mutation = await this.simplifiClient.updateTransaction(input.transactionId, merged);

    // Write the merged state directly to cache rather than triggering a full
    // incremental sync — avoids N concurrent syncs when bulk-tagging transactions.
    this.db.upsertTransactions([merged]);

    return {
      mutation,
      transaction: merged,
    };
  }

  public async createTransaction(input: {
    accountId: string;
    date: string;
    amount: number;
    payee: string;
    memo?: string;
    categoryId?: string;
  }): Promise<Record<string, unknown>> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
      throw new Error("date must be in YYYY-MM-DD format");
    }

    const accounts = await this.fetchAccounts();
    if (!accounts.some((a) => a.id === input.accountId)) {
      throw new Error(`Account ${input.accountId} not found; use list_accounts to find a valid account id`);
    }

    // Borrow source/state/matchState/type conventions from an existing transaction in the
    // same account (preferring the same sign), since the API requires them.
    await this.syncService.ensureFresh(this.maxStaleMs);
    const recent = this.db.listTransactions({ limit: 50, accountId: input.accountId }).items;
    const template = recent.find((t) => Math.sign(t.amount ?? 0) === Math.sign(input.amount)) ?? recent[0];

    const clientId = randomUUID();
    const transaction: Transaction = {
      id: clientId,
      clientId,
      accountId: input.accountId,
      postedOn: input.date,
      payee: input.payee,
      amount: input.amount,
      memo: input.memo ?? "",
      coa: input.categoryId ? { type: "CATEGORY", id: input.categoryId } : { type: "UNCATEGORIZED", id: "0" },
      source: template?.source ?? "MANUAL",
      state: template?.state ?? "CLEARED",
      matchState: template?.matchState ?? "NOT_MATCHED",
      type: template?.type ?? (input.amount < 0 ? "DEBIT" : "CREDIT"),
      tags: [],
      isDeleted: false,
    };
    this.assertUpsertRequiredFields(transaction);

    const mutation = await this.simplifiClient.createTransaction(transaction);
    const id = mutation.id ?? clientId;
    const created = { ...transaction, id };
    this.db.upsertTransactions([created]);

    return { transactionId: id, mutation, transaction: created };
  }

  public async listAccounts(): Promise<Record<string, unknown>> {
    const accounts = await this.fetchAccounts();
    return { accounts: accounts.map((a) => this.summarizeAccount(a)) };
  }

  public async getAccount(input: { accountId?: string; name?: string }): Promise<Record<string, unknown>> {
    if (!input.accountId && !input.name) {
      throw new Error("Either accountId or name is required");
    }
    const accounts = await this.fetchAccounts();
    let matches: Account[];
    if (input.accountId) {
      matches = accounts.filter((a) => a.id === input.accountId);
    } else {
      const wanted = input.name!.trim().toLowerCase();
      matches = accounts.filter((a) => a.name?.trim().toLowerCase() === wanted);
      if (matches.length === 0) {
        matches = accounts.filter((a) => a.name?.toLowerCase().includes(wanted));
      }
    }
    if (matches.length === 0) {
      throw new Error(`Account not found: ${input.accountId ?? input.name}`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Multiple accounts match: ${matches.map((a) => `${a.name} (${a.id})`).join(", ")}. Use accountId.`,
      );
    }
    return { account: this.summarizeAccount(matches[0]!), raw: matches[0] };
  }

  private async fetchAccounts(): Promise<Account[]> {
    const response = await this.simplifiClient.listAccounts();
    return (response.resources ?? []).filter((a) => !a.isDeleted);
  }

  // Account payloads are only partially documented, so balance/as-of are picked
  // from the first populated candidate field; the full payload is available via get_account.
  private summarizeAccount(account: Account): Record<string, unknown> {
    const pick = (keys: string[]): unknown => {
      for (const key of keys) {
        const value = account[key];
        if (value !== undefined && value !== null) return value;
      }
      return undefined;
    };
    return {
      id: account.id,
      name: account.name,
      type: account.type,
      balance: pick(["currentBalance", "balance", "currentBal", "availableBalance"]),
      balanceAsOf: pick(["balanceAsOf", "currentBalanceAsOf", "balanceUpdatedAt", "lastUpdatedAt", "modifiedAt"]),
    };
  }

  public async categorizeTransaction(input: { transactionId: string; categoryId: string }): Promise<Record<string, unknown>> {
    return this.updateTransaction({
      transactionId: input.transactionId,
      patch: {
        coa: { type: "CATEGORY", id: input.categoryId },
      },
    });
  }

  public async listUncategorizedTransactions(input: ListTransactionsInput): Promise<Record<string, unknown>> {
    await this.maybeRefresh(input.refresh ?? false);

    const page = this.db.listUncategorizedTransactions(this.toQuery(input));
    return {
      total: page.total,
      nextCursor: page.nextCursor,
      items: page.items,
    };
  }

  public async searchMerchants(input: { query: string; limit?: number; includeDeleted?: boolean }): Promise<Record<string, unknown>> {
    await this.syncService.ensureFresh(this.maxStaleMs);
    const merchants = this.db.searchMerchants({ q: input.query, limit: input.limit, includeDeleted: input.includeDeleted });
    return { merchants };
  }

  public async listCategories(input?: { refresh?: boolean; limit?: number }): Promise<Record<string, unknown>> {
    if (input?.refresh) {
      await this.referenceDataService.syncCategories();
    } else {
      await this.referenceDataService.ensureCategoriesFresh(this.maxStaleMs);
    }

    const categories = this.db.listCategories({ limit: input?.limit });
    return { categories };
  }

  public async searchCategories(input: { query: string; limit?: number; refresh?: boolean }): Promise<Record<string, unknown>> {
    if (input.refresh) {
      await this.referenceDataService.syncCategories();
    } else {
      await this.referenceDataService.ensureCategoriesFresh(this.maxStaleMs);
    }

    const categories = this.db.listCategories({ search: input.query, limit: input.limit });
    return { categories };
  }

  public async createTag(input: { name: string }): Promise<Record<string, unknown>> {
    const tag = await this.simplifiClient.createTag(input.name.trim());
    // Persist to local cache so it's immediately available for tagging tools.
    this.db.upsertTags([tag]);
    return { tag };
  }

  public async listTags(input?: { refresh?: boolean; limit?: number }): Promise<Record<string, unknown>> {
    if (input?.refresh) {
      await this.referenceDataService.syncTags();
    } else {
      await this.referenceDataService.ensureTagsFresh(this.maxStaleMs);
    }

    const tags = this.db.listTags({ limit: input?.limit });
    return { tags };
  }

  public async searchTags(input: { query: string; limit?: number; refresh?: boolean }): Promise<Record<string, unknown>> {
    if (input.refresh) {
      await this.referenceDataService.syncTags();
    } else {
      await this.referenceDataService.ensureTagsFresh(this.maxStaleMs);
    }

    const tags = this.db.listTags({ search: input.query, limit: input.limit });
    return { tags };
  }

  public async tagTransaction(input: { transactionId: string; tagIds: string[] }): Promise<Record<string, unknown>> {
    await this.syncService.ensureFresh(this.maxStaleMs);

    const current = this.db.getTransactionById(input.transactionId);
    if (!current) {
      throw new Error(`Transaction ${input.transactionId} not found in cache`);
    }

    const knownTags = this.db.listTags({});
    const tagMap = new Map<string, Tag>(knownTags.map((t) => [t.id!, t]));

    const existingIds = new Set((current.tags ?? []).map((t: TagRef) => t.id));
    const newTagRefs: TagRef[] = input.tagIds
      .filter((id) => !existingIds.has(id))
      .map((id) => {
        const tag = tagMap.get(id);
        return tag ? { id: tag.id!, name: tag.name } : { id };
      });

    return this.updateTransaction({
      transactionId: input.transactionId,
      patch: { tags: [...(current.tags ?? []), ...newTagRefs] },
    });
  }

  public async untagTransaction(input: { transactionId: string; tagIds: string[] }): Promise<Record<string, unknown>> {
    await this.syncService.ensureFresh(this.maxStaleMs);

    const current = this.db.getTransactionById(input.transactionId);
    if (!current) {
      throw new Error(`Transaction ${input.transactionId} not found in cache`);
    }

    const removeSet = new Set(input.tagIds);
    const updatedTags = (current.tags ?? []).filter((t: TagRef) => !removeSet.has(t.id));

    return this.updateTransaction({
      transactionId: input.transactionId,
      patch: { tags: updatedTags },
    });
  }

  public async setTransactionTags(input: { transactionId: string; tagIds: string[] }): Promise<Record<string, unknown>> {
    await this.referenceDataService.ensureTagsFresh(this.maxStaleMs);

    const knownTags = this.db.listTags({});
    const tagMap = new Map<string, Tag>(knownTags.map((t) => [t.id!, t]));

    const tagRefs: TagRef[] = input.tagIds.map((id) => {
      const tag = tagMap.get(id);
      return tag ? { id: tag.id!, name: tag.name } : { id };
    });

    return this.updateTransaction({
      transactionId: input.transactionId,
      patch: { tags: tagRefs },
    });
  }

  public async setTransactionMemo(input: { transactionId: string; memo: string }): Promise<Record<string, unknown>> {
    return this.updateTransaction({
      transactionId: input.transactionId,
      patch: { memo: input.memo },
    });
  }

  public async listTransactionsByTag(
    input: { tagId?: string; tagName?: string } & ListTransactionsInput,
  ): Promise<Record<string, unknown>> {
    await this.maybeRefresh(input.refresh ?? false);
    await this.referenceDataService.ensureTagsFresh(this.maxStaleMs);

    let resolvedTagId = input.tagId;
    if (!resolvedTagId && input.tagName) {
      const requestedName = input.tagName.trim().toLowerCase();
      const matches = this.db.listTags({}).filter((tag) => tag.name?.trim().toLowerCase() === requestedName);
      if (matches.length === 0) {
        throw new Error(`Tag not found: ${input.tagName}`);
      }
      if (matches.length > 1) {
        throw new Error(`Multiple tags match the name: ${input.tagName}`);
      }
      if (!matches[0]!.id) {
        throw new Error(`Tag not found: ${input.tagName}`);
      }
      resolvedTagId = matches[0]!.id;
    }

    if (!resolvedTagId) {
      throw new Error("Either tagId or tagName is required");
    }

    const page = this.db.listTransactionsByTag({ ...this.toQuery(input), tagId: resolvedTagId });
    return {
      total: page.total,
      nextCursor: page.nextCursor,
      items: page.items,
    };
  }

  public async suggestCategoriesForMerchant(input: {
    merchant: string;
    limit?: number;
    matchMode?: "exact" | "contains";
    refreshCategories?: boolean;
  }): Promise<Record<string, unknown>> {
    if (input.refreshCategories) {
      await this.referenceDataService.syncCategories();
    } else {
      await this.referenceDataService.ensureCategoriesFresh(this.maxStaleMs);
    }

    const suggestions = this.db.suggestCategoriesForMerchant({
      merchant: input.merchant,
      limit: input.limit,
      matchMode: input.matchMode,
    });

    return { suggestions };
  }

  private async maybeRefresh(forceRefresh: boolean): Promise<void> {
    if (forceRefresh) {
      await this.syncService.syncIncremental();
      return;
    }

    await this.syncService.ensureFresh(this.maxStaleMs);
  }

  private toQuery(input: {
    limit?: number;
    cursor?: string;
    accountId?: string;
    dateFrom?: string;
    dateTo?: string;
    minAmount?: number;
    maxAmount?: number;
    includeDeleted?: boolean;
  }): TransactionQuery {
    return {
      limit: Math.min(Math.max(input.limit ?? 50, 1), 200),
      cursor: input.cursor,
      accountId: input.accountId,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      minAmount: input.minAmount,
      maxAmount: input.maxAmount,
      includeDeleted: input.includeDeleted,
    };
  }

  private assertUpsertRequiredFields(transaction: Transaction): void {
    const requiredKeys = [
      "id",
      "accountId",
      "postedOn",
      "payee",
      "coa",
      "amount",
      "state",
      "matchState",
      "source",
      "type",
    ] as const;

    for (const key of requiredKeys) {
      const value = transaction[key];
      if (value === undefined || value === null || value === "") {
        throw new Error(`Updated transaction is missing required upsert field: ${key}`);
      }
    }

    const coa = transaction.coa;
    if (!coa || typeof coa !== "object" || typeof coa.type !== "string" || typeof coa.id !== "string") {
      throw new Error("Updated transaction has invalid coa object");
    }
  }
}
