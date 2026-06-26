import * as vscode from 'vscode';
import { createToastDedupe, TOAST_DEDUPE_MS } from './server-log-detect.js';

const toastDedupe = createToastDedupe(TOAST_DEDUPE_MS);

export function getExtensionToastDedupe(): ReturnType<typeof createToastDedupe> {
  return toastDedupe;
}

export function resetExtensionToastDedupe(): void {
  toastDedupe.reset();
}

export function showDedupedErrorToast(message: string, dedupeKey: string): void {
  if (toastDedupe.shouldShow(dedupeKey)) {
    void vscode.window.showErrorMessage(message);
  }
}

export function showDedupedWarningToast(message: string, dedupeKey: string): void {
  if (toastDedupe.shouldShow(dedupeKey)) {
    void vscode.window.showWarningMessage(message);
  }
}
