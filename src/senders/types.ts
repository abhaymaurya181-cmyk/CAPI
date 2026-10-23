export interface SendResult {
  ok: boolean;
  // Google validateOnly pass: request is valid but nothing was sent.
  validated?: boolean;
  status: number;
  body: string;
  error?: string;
}
