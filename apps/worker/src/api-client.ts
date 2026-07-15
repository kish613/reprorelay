import type { ReportRecord } from "@reprorelay/shared";

export class ReproRelayApiClient {
  constructor(
    private readonly apiUrl: string,
    private readonly internalToken?: string,
  ) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      ...extra,
      ...(this.internalToken ? { authorization: `Bearer ${this.internalToken}` } : {}),
    };
  }

  async listReports(): Promise<ReportRecord[]> {
    const response = await fetch(`${this.apiUrl}/v1/reports`, { headers: this.headers() });
    if (!response.ok) throw new Error(`Failed to list reports: ${response.status} ${await response.text()}`);
    return (await response.json()) as ReportRecord[];
  }

  async updateReport(id: string, patch: Partial<ReportRecord>): Promise<ReportRecord> {
    const response = await fetch(`${this.apiUrl}/v1/reports/${id}`, {
      method: "PATCH",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(patch),
    });
    if (!response.ok) throw new Error(`Failed to update report: ${response.status} ${await response.text()}`);
    return (await response.json()) as ReportRecord;
  }
}
