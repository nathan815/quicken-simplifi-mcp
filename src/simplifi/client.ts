import { URL } from "node:url";

import type { AppConfig } from "../config.js";
import type {
  CategoryListResponse,
  DatasetListResponse,
  EarliestDateOnResponse,
  Tag,
  TagListResponse,
  Transaction,
  TransactionListResponse,
  TransactionMutationResponse,
} from "../types.js";
import { SimplifiAuthService } from "./auth-service.js";

interface ListTransactionsInput {
  limit?: number;
  dateOnAfter?: string;
  modifiedAfter?: string;
  after?: string;
  currentPage?: number;
}

interface ListReferenceInput {
  limit?: number;
  modifiedAfter?: string;
}

export class SimplifiClient {
  private resolvedDatasetId: string | null = null;

  public constructor(
    private readonly config: AppConfig["simplifi"],
    private readonly authService: SimplifiAuthService,
    private readonly getStoredDatasetId: () => string | null,
    private readonly saveDatasetId: (id: string) => void,
  ) {}

  public async getDatasetId(): Promise<string> {
    if (this.config.datasetId) return this.config.datasetId;
    if (this.resolvedDatasetId) return this.resolvedDatasetId;

    const stored = this.getStoredDatasetId();
    if (stored) {
      this.resolvedDatasetId = stored;
      return stored;
    }

    const response = await this.listDatasets();
    const first = response.resources?.[0];
    if (!first?.id) {
      throw new Error("Simplifi /datasets returned no datasets. Check your credentials.");
    }
    this.resolvedDatasetId = first.id;
    this.saveDatasetId(first.id);
    return first.id;
  }

  public async listDatasets(): Promise<DatasetListResponse> {
    const url = new URL("/datasets", this.config.baseUrl);
    url.searchParams.set("limit", "100");
    return this.authedRequestNoDataset<DatasetListResponse>(url.toString(), { method: "GET" });
  }

  public async listTransactions(input: ListTransactionsInput): Promise<TransactionListResponse> {
    const url = new URL("/transactions", this.config.baseUrl);

    url.searchParams.set("limit", String(input.limit ?? this.config.pageLimit));

    if (input.dateOnAfter) {
      url.searchParams.set("dateOnAfter", input.dateOnAfter);
    }

    if (input.modifiedAfter) {
      url.searchParams.set("modifiedAfter", input.modifiedAfter);
    }

    if (input.after) {
      url.searchParams.set("after", input.after);
    }

    if (typeof input.currentPage === "number") {
      url.searchParams.set("currentPage", String(input.currentPage));
    }

    return this.authedRequest<TransactionListResponse>(url.toString(), {
      method: "GET",
    });
  }

  public async listTransactionsFromNextLink(nextLink: string): Promise<TransactionListResponse> {
    const url = new URL(nextLink, this.config.baseUrl);
    return this.authedRequest<TransactionListResponse>(url.toString(), {
      method: "GET",
    });
  }

  public async getEarliestDateOn(accountIds: string[] = []): Promise<EarliestDateOnResponse> {
    const url = new URL("/transactions/earliest-date-on", this.config.baseUrl);
    return this.authedRequest<EarliestDateOnResponse>(url.toString(), {
      method: "POST",
      body: JSON.stringify({ accountIds }),
    });
  }

  public async updateTransaction(transactionId: string, payload: Transaction): Promise<TransactionMutationResponse> {
    const url = new URL(`/transactions/${encodeURIComponent(transactionId)}`, this.config.baseUrl);
    return this.authedRequest<TransactionMutationResponse>(url.toString(), {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  }

  public async listCategories(input: ListReferenceInput = {}): Promise<CategoryListResponse> {
    const url = new URL("/categories", this.config.baseUrl);
    url.searchParams.set("limit", String(input.limit ?? 5000));
    if (input.modifiedAfter) {
      url.searchParams.set("modifiedAfter", input.modifiedAfter);
    }
    return this.authedRequest<CategoryListResponse>(url.toString(), { method: "GET" });
  }

  public async listCategoriesFromNextLink(nextLink: string): Promise<CategoryListResponse> {
    const url = new URL(nextLink, this.config.baseUrl);
    return this.authedRequest<CategoryListResponse>(url.toString(), { method: "GET" });
  }

  public async createTag(name: string): Promise<Tag> {
    const url = new URL("/tags", this.config.baseUrl);
    return this.authedRequest<Tag>(url.toString(), {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  public async listTags(input: ListReferenceInput = {}): Promise<TagListResponse> {
    const url = new URL("/tags", this.config.baseUrl);
    url.searchParams.set("limit", String(input.limit ?? 5000));
    if (input.modifiedAfter) {
      url.searchParams.set("modifiedAfter", input.modifiedAfter);
    }
    return this.authedRequest<TagListResponse>(url.toString(), { method: "GET" });
  }

  public async listTagsFromNextLink(nextLink: string): Promise<TagListResponse> {
    const url = new URL(nextLink, this.config.baseUrl);
    return this.authedRequest<TagListResponse>(url.toString(), { method: "GET" });
  }

  private async authedRequest<T>(url: string, init: RequestInit): Promise<T> {
    const [token, datasetId] = await Promise.all([
      this.authService.getAccessToken(),
      this.getDatasetId(),
    ]);
    return this.doRequest<T>(url, init, token, datasetId);
  }

  private async authedRequestNoDataset<T>(url: string, init: RequestInit): Promise<T> {
    const token = await this.authService.getAccessToken();
    return this.doRequest<T>(url, init, token);
  }

  private async doRequest<T>(url: string, init: RequestInit, token: string, datasetId?: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.httpTimeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(datasetId ? { "qcs-dataset-id": datasetId } : {}),
          "app-client-id": this.config.clientId,
          "app-release": "6.5.0",
          "app-build": "63580",
          ...(init.headers ?? {}),
        },
      });

      if (response.status >= 400) {
        const body = await response.text();
        throw new Error(`Simplifi request failed status=${response.status}, url=${url}, body=${body}`);
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
