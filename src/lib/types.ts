// Session constants
export const SESSION_NAME_MAX_LENGTH = 100;

// GitHub Issue interface
export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string; color: string }>;
  comments: number;
}
