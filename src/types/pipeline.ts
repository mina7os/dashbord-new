export interface GoogleTokens {
  access_token: string;
  refresh_token: string;
  expiry_date?: number;
}

export interface PipelineContext {
  userId: string;
  sheetId?: string;
  folderId?: string;
  tokens?: GoogleTokens | null;
  activeChats: Set<string>;
}
