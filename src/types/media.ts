export const CANONICAL_MEDIA_MODALITIES = ['text', 'image', 'pdf', 'handwriting', 'unknown'] as const;

export type MediaSourceType = typeof CANONICAL_MEDIA_MODALITIES[number];

export function normalizeMediaSourceType(value?: string | null): MediaSourceType {
  const normalized = String(value || '').trim().toLowerCase();

  if (!normalized) return 'unknown';
  if (normalized === 'screenshot' || normalized === 'photo' || normalized === 'receipt' || normalized.startsWith('image/')) {
    return 'image';
  }
  if (normalized === 'application/pdf' || normalized === 'pdf') {
    return 'pdf';
  }
  if (normalized === 'text' || normalized === 'plain_text') {
    return 'text';
  }
  if (normalized === 'handwriting' || normalized === 'handwritten') {
    return 'handwriting';
  }
  if (CANONICAL_MEDIA_MODALITIES.includes(normalized as MediaSourceType)) {
    return normalized as MediaSourceType;
  }

  return 'unknown';
}

export function deriveMediaSourceTypeFromMime(actualMimeType?: string | null, hasMedia?: boolean): MediaSourceType {
  const mime = String(actualMimeType || '').toLowerCase();

  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (!hasMedia) return 'text';

  return 'unknown';
}
