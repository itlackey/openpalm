/** Raw AKM task editor state and pinned AKM task filename checks. */

import { schedulableTaskFilenameError } from '@openpalm/lib/control-plane/task-file-contract.js';

/** Returns an error message or null if valid. */
export function validateTaskFilename(name: string): string | null {
  if (!name.trim()) return 'File name is required';
  return schedulableTaskFilenameError(name.trim());
}

export interface TaskFormData {
  fileName: string;
  rawYaml: string;
  revision: string | null;
}

/** Initialize the text editor without parsing or reformatting the task. */
export function yamlToFormData(fileName: string, content: string, revision: string): TaskFormData {
  return { fileName, rawYaml: content, revision };
}

/** Create default form data for a new task. */
export function newFormData(): TaskFormData {
  return {
    fileName: '',
    revision: null,
    rawYaml: `version: 2
schedule: "0 9 * * *"
enabled: false
command:
  - /bin/sh
  - -c
  - echo hello
`,
  };
}
