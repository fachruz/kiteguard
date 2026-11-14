/**
 * Audit receipts.
 *
 * One line per event, JSONL. Two fields are deliberately kept apart:
 *   rule        — the deterministic fact that decided the step
 *   explanation — the model's (SERV's) commentary about the step
 * An auditor can point at one and read the other; commentary is never
 * allowed to masquerade as the reason a payment happened.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ReceiptEntry {
  ts: string;
  step: string;
  rule: string;
  explanation: string;
  data?: Record<string, unknown>;
}

export class ReceiptLog {
  private readonly entries: ReceiptEntry[] = [];

  constructor(private readonly filePath?: string) {
    if (filePath) mkdirSync(dirname(filePath), { recursive: true });
  }

  add(step: string, rule: string, explanation: string, data?: Record<string, unknown>): ReceiptEntry {
    const entry: ReceiptEntry = { ts: new Date().toISOString(), step, rule, explanation, data };
    this.entries.push(entry);
    if (this.filePath) appendFileSync(this.filePath, JSON.stringify(entry) + "\n");
    return entry;
  }

  all(): readonly ReceiptEntry[] {
    return this.entries;
  }

  render(): string {
    return this.entries
      .map((e) => `[${e.step}] rule: ${e.rule}\n         serv: ${e.explanation}`)
      .join("\n");
  }
}
