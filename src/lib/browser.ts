/**
 * Browser utilities for opening URLs
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Open a URL in the default browser
 */
export async function openInBrowser(url: string): Promise<void> {
  const platform = process.platform;
  
  let command: string;
  if (platform === 'darwin') {
    command = `open "${url}"`;
  } else if (platform === 'win32') {
    command = `start "" "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  await execAsync(command);
}

export function getDocumentWebUrl(uuid: string): string {
  return `https://app.okrapdf.com/ocr/${uuid}`;
}

export function getJobWebUrl(jobId: string): string {
  return `https://app.okrapdf.com/ocr/${jobId}`;
}

export function getLibraryWebUrl(): string {
  return 'https://app.okrapdf.com/ocr';
}
