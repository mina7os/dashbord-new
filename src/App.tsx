import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { Session } from '@supabase/supabase-js';
import io from 'socket.io-client';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell
} from 'recharts';
import { Search, RefreshCw, Check, X, AlertCircle, TrendingUp, Wallet, Clock, Settings, LogOut, ChevronLeft, ChevronRight, Sun, Moon } from 'lucide-react';
import Integrations from './components/Integrations';
import { supabase } from './lib/supabase';

// â”€â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
interface Transaction {
  id?: string;
  record_id?: string | number;
  created_at: string;
  transaction_date: string;
  amount: number;
  currency: string;
  sender_name: string;
  beneficiary_name: string;
  client_name?: string;
  beneficiary_account?: string;
  transaction_type: string;
  channel: string;
  processing_status: string;
  reference_number: string;
  bank_name?: string;
}

function TransactionEditModal({
  item,
  onClose,
  onSave,
}: {
  item: Transaction;
  onClose: () => void;
  onSave: (updates: any, comment?: string) => void;
}) {
  const [fields, setFields] = useState<any>({
    transaction_date: item.transaction_date || '',
    transaction_type: item.transaction_type || '',
    bank_name: item.bank_name || '',
    sender_name: item.sender_name || '',
    client_name: item.client_name || '',
    beneficiary_name: item.beneficiary_name || '',
    beneficiary_account: item.beneficiary_account || '',
    amount: item.amount ?? '',
    currency: item.currency || 'EGP',
    reference_number: item.reference_number || '',
  });
  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    onSave(fields, comment);
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)'
    }} onClick={onClose}>
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '20px',
        padding: '2rem', width: '100%', maxWidth: '620px', maxHeight: '82vh', overflowY: 'auto'
      }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <h3 style={{ margin: 0 }}>Edit Transaction</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}>
            <X size={20} />
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '1.5rem' }}>
          {['transaction_date', 'transaction_type', 'bank_name', 'sender_name', 'client_name', 'beneficiary_name', 'beneficiary_account', 'amount', 'currency', 'reference_number'].map(key => (
            <div key={key}>
              <label style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{key.replace(/_/g, ' ')}</label>
              <input
                value={fields[key] ?? ''}
                onChange={e => setFields((f: any) => ({ ...f, [key]: e.target.value }))}
                style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '6px', padding: '6px 10px', color: 'var(--text)', fontSize: '0.85rem', boxSizing: 'border-box' }}
              />
            </div>
          ))}
        </div>

        <div style={{ marginBottom: '1.5rem' }}>
          <label style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Change Comment (Optional)
          </label>
          <textarea
            value={comment}
            onChange={e => setComment(e.target.value)}
            placeholder="Explain what you changed in this transaction..."
            rows={3}
            style={{
              width: '100%',
              marginTop: '0.5rem',
              background: 'var(--surface2)',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              padding: '10px 12px',
              color: 'var(--text)',
              fontSize: '0.85rem',
              boxSizing: 'border-box',
              resize: 'vertical'
            }}
          />
        </div>

        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button onClick={handleSave} disabled={saving} style={{ flex: 1, padding: '10px', background: 'var(--accent)', border: 'none', borderRadius: '8px', color: 'white', cursor: 'pointer', fontWeight: 600 }}>
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
          <button onClick={onClose} style={{ padding: '10px 16px', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)', cursor: 'pointer' }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

interface ReviewItem {
  id: string;
  created_at: string;
  raw_text: string;
  review_status: string;
  suggested_data: any;
  reason?: string;
  confidence?: number;
}

interface QueueItem {
  id: string;
  message_id: string;
  chat_id: string;
  processing_status: string;
  processing_stage: string;
  attempt_count: number;
  last_error?: string;
  received_at: string;
}

function getTransactionRowKey(tx: Transaction) {
  return String(tx.record_id ?? tx.id ?? tx.reference_number ?? tx.created_at);
}

interface Stats {
  total_messages: number;
  financial_candidates: number;
  successful_extractions: number;
  pending_review: number;
  duplicates: number;
}

interface DailyMetric {
  date: string;
  successful_extractions: number;
}

interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
}

interface TransactionFilters {
  dateFrom: string;
  dateTo: string;
  type: string;
  bank: string;
  status: string;
  currency: string;
  sender: string;
  receiver: string;
}

interface AccessState {
  role: 'manager' | 'cfo' | 'admin' | 'viewer';
  canReadAllData: boolean;
  canEditAllData: boolean;
  canEditOwnData: boolean;
  canReview: boolean;
  canUseIntegrations: boolean;
  canManageSystem: boolean;
  mustProvideChangeReason: boolean;
}

const ITEMS_PER_PAGE = 25;
const EMPTY_TRANSACTION_FILTERS: TransactionFilters = {
  dateFrom: '',
  dateTo: '',
  type: '',
  bank: '',
  status: '',
  currency: '',
  sender: '',
  receiver: '',
};

function normalizeEntityName(value?: string | null) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeArabicCompanyName(value?: string | null) {
  return String(value || '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ئ/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function includesAny(value: string, fragments: string[]) {
  return fragments.some((fragment) => value.includes(fragment));
}

function canonicalizeReceiverName(value?: string | null) {
  const normalized = normalizeEntityName(value);
  if (!normalized) return 'unknown-receiver';

  const arabicNormalized = normalizeArabicCompanyName(value);

  const isGulfArabianOilsEnglish =
    includesAny(normalized, ['gulf arabian', 'arabian gulf', 'alarabya elkhalygya', 'alarabya elkhalygia', 'alarabia elkhalygya', 'alarabia elkhalygia']) &&
    includesAny(normalized, ['oil', 'oils', 'edible oils', 'refining', 'refinin']);

  const isGulfArabianOilsArabic =
    includesAny(arabicNormalized, ['العربيه الخليجيه', 'العربية الخليجية', 'عربيه خليجيه']) &&
    includesAny(arabicNormalized, ['زيوت', 'نباتيه', 'تكرير', 'تعبئه', 'عصر']);

  if (isGulfArabianOilsEnglish || isGulfArabianOilsArabic) {
    return 'receiver:gulf-arabian-edible-oils';
  }

  const isFabrikTextileEnglish =
    includesAny(normalized, ['fabrik textile', 'fabric textile', 'textile']) &&
    includesAny(normalized, ['printing', 'hygienic', 'health products']);

  const isFabrikTextileArabic =
    includesAny(arabicNormalized, ['فابريك تكستايل']) &&
    includesAny(arabicNormalized, ['طباعه', 'منتجات صحيه', 'صحيه']);

  if (isFabrikTextileEnglish || isFabrikTextileArabic) {
    return 'receiver:fabrik-textile-health-products';
  }

  const stopWords = new Set([
    'company', 'co', 'group', 'for', 'of', 'and', 'the', 'llc', 'ltd',
    'شركة', 'شركه', 'ذ', 'م',
  ]);

  const tokens = normalized
    .split(' ')
    .filter((token) => token.length > 1 && !stopWords.has(token));

  return Array.from(new Set(tokens)).sort().join(' ') || normalized;
}

function normalizeBankName(value?: string | null) {
  const normalized = normalizeEntityName(value);
  if (!normalized) return 'unknown bank';

  const bankTokens = normalized
    .split(' ')
    .map((token) => token.replace(/^ال/u, ''))
    .filter(Boolean);
  const hasToken = (fragment: string) => bankTokens.some((token) => token.includes(fragment));

  const aliases: Array<[RegExp, string]> = [
    [/\bbanque\s+misr\b|\bbank\s+misr\b|\bmisr\b/, 'Banque Misr'],
    [/\bnational\s+bank\s+of\s+egypt\b|\bnbe\b/, 'National Bank of Egypt'],
    [/\bcib\b|\bcommercial\s+international\s+bank\b/, 'CIB'],
    [/\bqnb\b|\bqnb\s+alahli\b|\bqnb\s+alahli\b/, 'QNB Alahli'],
    [/\bhsbc\b/, 'HSBC'],
    [/\bsaib\b/, 'SAIB'],
    [/\bcredit\s+agricole\b/, 'Credit Agricole'],
    [/\balex\s*bank\b|\balexbank\b/, 'AlexBank'],
    [/\battijariwafa\b/, 'Attijariwafa Bank'],
    [/\bfaisal\b/, 'Faisal Islamic Bank'],
    [/\babk\b|\bahli\s+united\b/, 'Ahli United Bank'],
  ];

  for (const [pattern, label] of aliases) {
    if (pattern.test(normalized)) return label;
  }

  if (hasToken('cib') || (hasToken('commercial') && hasToken('international'))) {
    return 'CIB';
  }
  if (hasToken('misr')) {
    return 'Banque Misr';
  }
  if (hasToken('nbe') || (hasToken('national') && hasToken('egypt'))) {
    return 'National Bank of Egypt';
  }
  if (hasToken('qnb')) {
    return 'QNB Alahli';
  }

  return String(value || 'Unknown Bank').trim() || 'Unknown Bank';
}

function getReceiverIdentity(tx: Transaction) {
  const candidates = [tx.beneficiary_name, tx.client_name]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  const unique = Array.from(new Set(candidates));
  if (unique.length === 0) {
    const fallbackAccount = String(tx.beneficiary_account || '').trim();
    if (fallbackAccount) {
      return { label: `Account ${fallbackAccount}`, aliases: [] as string[], key: `receiver-account-${fallbackAccount}` };
    }
    return { label: 'Unknown Receiver', aliases: [] as string[], key: 'unknown-receiver' };
  }

  const sorted = [...unique].sort((a, b) => b.length - a.length);
  const primary = sorted[0];
  const aliases = sorted.slice(1).filter((alias) => {
    const normalizedPrimary = normalizeEntityName(primary);
    const normalizedAlias = normalizeEntityName(alias);
    return normalizedAlias && normalizedAlias !== normalizedPrimary && !normalizedPrimary.includes(normalizedAlias);
  });

  const key = canonicalizeReceiverName(primary);
  return { label: primary, aliases, key };
}

function normalizeReceiverGroupKey(value?: string | null) {
  const normalized = normalizeEntityName(value);
  if (!normalized) return 'unknown-receiver';

  const stopWords = new Set([
    'الشركة', 'شركة', 'شركه', 'company', 'co', 'group',
    'for', 'of', 'and', 'the', 'llc', 'ltd',
  ]);

  const tokens = normalized
    .split(' ')
    .map((token) => token.replace(/^ال/u, ''))
    .filter((token) => token.length > 1 && !stopWords.has(token));

  const hasGulfArabia =
    tokens.some((token) => token.includes('عربية') || token.includes('عربيه')) &&
    tokens.some((token) => token.includes('خليج'));
  const hasOils =
    tokens.some((token) => token.includes('زيوت')) ||
    tokens.some((token) => token.includes('نبات')) ||
    tokens.some((token) => token.includes('تعب')) ||
    tokens.some((token) => token.includes('تكرير')) ||
    tokens.some((token) => token.includes('عصر'));

  if (hasGulfArabia && hasOils) {
    return 'receiver:arabia-gulf-oils';
  }

  return Array.from(new Set(tokens)).sort().join(' ') || normalized;
}

function buildReceiverSummaries(transactions: Transaction[]) {
  const groups = new Map<string, {
    key: string;
    label: string;
    aliases: Set<string>;
    total: number;
    currency: string;
    count: number;
  }>();

  for (const tx of transactions) {
    const receiver = getReceiverIdentity(tx);
    const key = receiver.key || normalizeReceiverGroupKey(receiver.label) || 'unknown-receiver';
    const amount = Math.abs(Number(tx.amount) || 0);
    const currency = tx.currency || 'EGP';
    const current = groups.get(key) || {
      key,
      label: receiver.label,
      aliases: new Set<string>(),
      total: 0,
      currency,
      count: 0,
    };

    if (receiver.label.length > current.label.length) {
      current.aliases.add(current.label);
      current.label = receiver.label;
    } else if (receiver.label !== current.label) {
      current.aliases.add(receiver.label);
    }

    for (const alias of receiver.aliases) {
      if (alias && alias !== current.label) {
        current.aliases.add(alias);
      }
    }

    if (tx.client_name && canonicalizeReceiverName(tx.client_name) === key && tx.client_name !== current.label) {
      current.aliases.add(tx.client_name);
    }
    if (tx.beneficiary_name && canonicalizeReceiverName(tx.beneficiary_name) === key && tx.beneficiary_name !== current.label) {
      current.aliases.add(tx.beneficiary_name);
    }

    current.total += amount;
    current.count += 1;
    groups.set(key, current);
  }

  return Array.from(groups.values())
    .map((group) => ({
      key: group.key,
      label: group.label,
      aliases: Array.from(group.aliases).filter((alias) => normalizeEntityName(alias) !== normalizeEntityName(group.label)),
      total: group.total,
      currency: group.currency,
      count: group.count,
    }))
    .sort((a, b) => b.total - a.total);
}

// â”€â”€â”€ Toast Component â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  return (
    <div style={{ position: 'fixed', bottom: '2rem', right: '2rem', zIndex: 9999, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {toasts.map(t => (
        <div key={t.id} style={{
          display: 'flex', alignItems: 'center', gap: '0.75rem',
          padding: '12px 16px', borderRadius: '10px', minWidth: '280px', maxWidth: '400px',
          background: t.type === 'success' ? 'rgba(34,197,94,0.1)' : t.type === 'error' ? 'rgba(239,68,68,0.1)' : 'rgba(99,102,241,0.1)',
          border: `1px solid ${t.type === 'success' ? 'rgba(34,197,94,0.3)' : t.type === 'error' ? 'rgba(239,68,68,0.3)' : 'rgba(99,102,241,0.3)'}`,
          backdropFilter: 'blur(12px)',
          animation: 'fadeIn 0.2s ease-out',
          fontSize: '0.875rem',
          color: 'white',
        }}>
          {t.type === 'success' ? <Check size={16} color="#22c55e" /> : t.type === 'error' ? <AlertCircle size={16} color="#ef4444" /> : <Clock size={16} color="var(--accent)" />}
          <span style={{ flex: 1 }}>{t.message}</span>
          <button onClick={() => onDismiss(t.id)} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: '2px' }}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

// â”€â”€â”€ Review Item Modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function ReviewModal({ item, token, onClose, onAction, requireComment = false }: {
  item: ReviewItem; token: string;
  onClose: () => void;
  onAction: (action: 'approve' | 'reject' | 'edit', corrected?: any, comment?: string) => void;
  requireComment?: boolean;
}) {
  const [editMode, setEditMode] = useState(false);
  const [fields, setFields] = useState<any>(item.suggested_data || {});
  const [saving, setSaving] = useState(false);
  const [comment, setComment] = useState('');

  const handleSave = async (action: 'approve' | 'reject' | 'edit') => {
    if (requireComment && !comment.trim()) return;
    setSaving(true);
    onAction(action, action === 'edit' ? fields : undefined, comment);
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)'
    }} onClick={onClose}>
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '20px',
        padding: '2rem', width: '100%', maxWidth: '560px', maxHeight: '80vh', overflowY: 'auto'
      }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <h3 style={{ margin: 0 }}>Review Transaction</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}>
            <X size={20} />
          </button>
        </div>

        <div style={{ background: 'var(--surface2)', borderRadius: '10px', padding: '1rem', marginBottom: '1.5rem', fontSize: '0.85rem', color: 'var(--muted)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--text)' }}>Raw Message:</strong><br />
          {item.raw_text || 'No raw text available'}
        </div>

        {editMode ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '1.5rem' }}>
            {['amount', 'currency', 'sender_name', 'beneficiary_name', 'bank_name', 'transaction_type', 'transaction_date', 'reference_number'].map(key => (
              <div key={key}>
                <label style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{key.replace(/_/g, ' ')}</label>
                <input
                  value={fields[key] || ''}
                  onChange={e => setFields((f: any) => ({ ...f, [key]: e.target.value }))}
                  style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '6px', padding: '6px 10px', color: 'var(--text)', fontSize: '0.85rem', boxSizing: 'border-box' }}
                />
              </div>
            ))}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '1.5rem' }}>
            {Object.entries(item.suggested_data || {}).filter(([k]) => !['user_id', 'duplicate', 'processing_status', 'source_document_type', 'raw_text'].includes(k)).map(([k, v]) => (
              <div key={k} style={{ background: 'var(--surface2)', padding: '8px 12px', borderRadius: '8px' }}>
                <div style={{ fontSize: '0.65rem', color: 'var(--muted)', textTransform: 'uppercase' }}>{k.replace(/_/g, ' ')}</div>
                <div style={{ color: 'var(--text)', fontSize: '0.85rem', fontWeight: 500 }}>{String(v ?? '-')}</div>
              </div>
            ))}
          </div>
        )}

        <div style={{ marginBottom: '1.5rem' }}>
          <label style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Change Comment {requireComment ? '(Required)' : '(Optional)'}
          </label>
          <textarea
            value={comment}
            onChange={e => setComment(e.target.value)}
            placeholder="Explain why you are approving, rejecting, or editing this item..."
            rows={3}
            style={{
              width: '100%',
              marginTop: '0.5rem',
              background: 'var(--surface2)',
              border: `1px solid ${requireComment && !comment.trim() ? 'rgba(239,68,68,0.4)' : 'var(--border)'}`,
              borderRadius: '8px',
              padding: '10px 12px',
              color: 'var(--text)',
              fontSize: '0.85rem',
              boxSizing: 'border-box',
              resize: 'vertical'
            }}
          />
        </div>

        <div style={{ display: 'flex', gap: '0.75rem' }}>
          {editMode ? (
            <>
              <button onClick={() => handleSave('edit')} disabled={saving} style={{ flex: 1, padding: '10px', background: 'var(--accent)', border: 'none', borderRadius: '8px', color: 'white', cursor: 'pointer', fontWeight: 600 }}>
                {saving ? 'Saving...' : 'Save & Approve'}
              </button>
              <button onClick={() => setEditMode(false)} style={{ padding: '10px 16px', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)', cursor: 'pointer' }}>Cancel</button>
            </>
          ) : (
            <>
              <button onClick={() => handleSave('approve')} disabled={saving} style={{ flex: 1, padding: '10px', background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: '8px', color: '#22c55e', cursor: 'pointer', fontWeight: 600 }}>
                <Check size={14} style={{ marginRight: '6px', display: 'inline' }} />{saving ? '...' : 'Approve'}
              </button>
              <button onClick={() => setEditMode(true)} style={{ flex: 1, padding: '10px', background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: '8px', color: 'var(--accent)', cursor: 'pointer', fontWeight: 600 }}>
                Edit
              </button>
              <button onClick={() => handleSave('reject')} disabled={saving} style={{ padding: '10px 16px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '8px', color: '#ef4444', cursor: 'pointer', fontWeight: 600 }}>
                <X size={14} style={{ marginRight: '4px', display: 'inline' }} />{saving ? '...' : 'Reject'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// â”€â”€â”€ Inspector Modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function InspectorModal({ id, token, onClose }: { id: string; token: string; onClose: () => void }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/pipeline/incoming/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setData(d))
      .catch(e => console.error(e))
      .finally(() => setLoading(false));
  }, [id, token]);

  if (loading) return null; // Or a spinner

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(8px)'
    }} onClick={onClose}>
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '24px',
        padding: '2.5rem', width: '100%', maxWidth: '750px', maxHeight: '90vh', overflowY: 'auto',
        boxShadow: '0 20px 50px rgba(0,0,0,0.5)'
      }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
          <h2 style={{ margin: 0 }}>Pipeline Inspection</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}>
            <X size={24} />
          </button>
        </div>

        {!data ? <div style={{ color: 'var(--red)' }}>Failed to load inspector data.</div> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
            {/* Health Header */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem' }}>
              <div className="stat-card glass" style={{ padding: '1rem' }}>
                <div className="label">Status</div>
                <div style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: '0.8rem', color: data.status.includes('failed') ? 'var(--red)' : 'var(--accent)' }}>{data.status}</div>
              </div>
              <div className="stat-card glass" style={{ padding: '1rem' }}>
                <div className="label">Stage</div>
                <div style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: '0.8rem' }}>{data.stage}</div>
              </div>
              <div className="stat-card glass" style={{ padding: '1rem' }}>
                <div className="label">Attempts</div>
                <div style={{ fontWeight: 700, fontSize: '0.8rem' }}>{data.attempts} / 5</div>
              </div>
              <div className="stat-card glass" style={{ padding: '1rem' }}>
                <div className="label">Is Financial</div>
                <div style={{ fontWeight: 700, color: data.is_financial ? 'var(--green)' : 'var(--muted)' }}>{data.is_financial ? 'YES' : 'NO'}</div>
              </div>
            </div>

            {/* Error (if any) */}
            {data.last_error && (
              <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '12px', padding: '1rem', color: '#f87171' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '4px' }}>
                  <AlertCircle size={14} /> <strong>Last Error</strong>
                </div>
                <div style={{ fontSize: '0.85rem', fontFamily: 'monospace' }}>{data.last_error}</div>
              </div>
            )}

            {/* Raw Text */}
            <div style={{ background: 'var(--surface2)', borderRadius: '12px', padding: '1.25rem' }}>
              <h4 style={{ margin: '0 0 0.75rem 0', fontSize: '0.9rem' }}>Captured Payload</h4>
              <div style={{ fontSize: '0.85rem', color: 'var(--muted)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{data.raw_text || '(Empty)'}</div>
            </div>

            {/* Outcomes */}
            <div>
              <h4 style={{ margin: '0 0 1rem 0', fontSize: '0.9rem' }}>Downstream Results</h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {data.results.transactions.length === 0 && data.results.reviews.length === 0 && (
                  <div style={{ color: 'var(--muted)', fontSize: '0.85rem', fontStyle: 'italic' }}>No downstream records found (yet).</div>
                )}
                {data.results.transactions.map((tx: any) => (
                  <div key={tx.record_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 1rem', background: 'rgba(34,197,94,0.05)', border: '1px solid rgba(34,197,94,0.2)', borderRadius: '10px' }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>Transaction Created</div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--muted)' }}>Ref: {tx.reference_number || 'None'}</div>
                    </div>
                    <div style={{ fontWeight: 700, color: 'var(--green)' }}>{tx.amount} {tx.currency}</div>
                  </div>
                ))}
                {data.results.reviews.map((rv: any) => (
                  <div key={rv.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 1rem', background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: '10px' }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>Pending Review</div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--muted)' }}>Reason: {rv.reason}</div>
                    </div>
                    <div style={{ fontWeight: 700, color: 'var(--yellow)' }}>Conf: {Math.round(rv.confidence * 100)}%</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// â”€â”€â”€ Main App â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef<Session | null>(null); // Fix H5: stale closure
  const [tab, setTab] = useState<'transactions' | 'review' | 'queue' | 'integrations'>('transactions');
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [reviewQueue, setReviewQueue] = useState<ReviewItem[]>([]);
  const [incomingQueue, setIncomingQueue] = useState<QueueItem[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [historicalMetrics, setHistoricalMetrics] = useState<DailyMetric[]>([]);
  const [totals, setTotals] = useState({ egp_total: 0, usd_total: 0 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [transactionFilters, setTransactionFilters] = useState<TransactionFilters>(EMPTY_TRANSACTION_FILTERS);
  const [authStatus, setAuthStatus] = useState<string>('');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [page, setPage] = useState(0);
   const [selectedReviewItem, setSelectedReviewItem] = useState<ReviewItem | null>(null);
  const [selectedInspectId, setSelectedInspectId] = useState<string | null>(null);
  const [selectedTransactionEdit, setSelectedTransactionEdit] = useState<Transaction | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [degradedMode, setDegradedMode] = useState<boolean>(false);
  const [access, setAccess] = useState<AccessState | null>(null);
  const [accessibleSheets, setAccessibleSheets] = useState<Array<{ user_id: string; email: string; role: string; sheetId: string; url: string }>>([]);

  // Integration States
  const [googleConnected, setGoogleConnected] = useState(false);
  const [sheetUrl, setSheetUrl] = useState<string | null>(null);
  const [whatsappStatus, setWhatsappStatus] = useState<any>('disconnected');
  const [whatsappStatusPayload, setWhatsappStatusPayload] = useState<any>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const socketRef = useRef<any>(null);
  const setupAttemptedRef = useRef<boolean>(false);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const addToast = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  // â”€â”€â”€ Auth â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  useEffect(() => {
    const recoverSession = async () => {
      const params = new URLSearchParams(window.location.search);
      const error = params.get('error_description') || params.get('error');
      if (error) setAuthStatus(`Login Error: ${error}`);

      try {
        const { data: { session } } = await Promise.race([
          supabase.auth.getSession(),
          new Promise<any>((_, reject) => setTimeout(() => reject(new Error('Auth timeout')), 5000)),
        ]);
        sessionRef.current = session;
        setSession(session);
      } catch (err) {
        console.error('[Auth] Session recovery failed:', err);
      } finally {
        setLoading(false);
      }
    };

    recoverSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
      sessionRef.current = session;
      setSession(session);

      if (_event === 'SIGNED_IN' && session) {
        const { provider_token, provider_refresh_token, user } = session;
        if (provider_token || provider_refresh_token) {
          const tokens = {
            access_token: provider_token,
            refresh_token: provider_refresh_token,
            expiry_date: Date.now() + 3500 * 1000,
          };

          // Use the new robust backend endpoint
          fetch('/api/integrations/google-tokens', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
            body: JSON.stringify({ tokens }),
          }).then(async (res) => {
            if (res.ok) {
              setGoogleConnected(true);
              // After saving tokens, trigger setup-database if sheet_id is missing and we haven't tried yet
              if (setupAttemptedRef.current) return;
              
              const { data: integration } = await supabase.from('user_integrations').select('sheet_id').eq('user_id', user.id).maybeSingle();
              if (!integration?.sheet_id || integration?.sheet_id === '1mock_sheet_id') {
                setupAttemptedRef.current = true;
                const setupRes = await fetch('/api/integrations/setup-database', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
                  body: JSON.stringify({ userId: user.id }),
                });
                const setupData = await setupRes.json();
                if (setupRes.ok && setupData.status === 'success') {
                  addToast('Google Sheets database ready!', 'success');
                } else if (!setupRes.ok || setupData.error) {
                  const isPermissionError = setupData.error?.includes('Permission') || setupData.error?.includes('Insufficient');
                  if (isPermissionError) {
                    addToast('Permission Denied: Please check the Drive/Sheets boxes during Sign-In!', 'error');
                  }
                  setupAttemptedRef.current = false;
                }
              }
            }
          }).catch(err => console.error('[Auth] Token persistence failed:', err));
        }
      }
    });

    return () => subscription.unsubscribe();
    // No debug global click listener â€” removed M3
  }, []);

  // â”€â”€â”€ Data Loading â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const loadData = useCallback(async (showLoading = true) => {
    const currentSession = sessionRef.current; // Fix H5: use ref, not stale state
    if (!currentSession) return;

    if (showLoading) setLoading(true);
    setRefreshing(true);
    try {
      const { user } = currentSession;
      const token = currentSession.access_token;

      const [ctxRes, txRes, rqRes, iqRes, statsRes, histRes, healthRes] = await Promise.all([
        fetch('/api/me/context', {
          headers: { Authorization: `Bearer ${token}` }
        }).then(r => r.json()),
        fetch('/api/transactions', {
          headers: { Authorization: `Bearer ${token}` }
        }).then(r => r.json()),
        fetch('/api/review-queue', {
          headers: { Authorization: `Bearer ${token}` }
        }).then(r => r.json()),
        fetch(`/api/pipeline/incoming?limit=100`, {
          headers: { Authorization: `Bearer ${token}` }
        }).then(r => r.json()),
        fetch(`/api/dashboard/stats?userId=${user.id}`, {
          headers: { Authorization: `Bearer ${token}` }
        }).then(r => r.json()),
        fetch('/api/dashboard/history', {
          headers: { Authorization: `Bearer ${token}` }
        }).then(r => r.json()),
        fetch('/api/health').then(r => r.json()).catch(() => ({ status: 'unknown' }))
      ]);

      setAccess(ctxRes.access || null);
      setAccessibleSheets(ctxRes.accessibleSheets || []);
      setTransactions((txRes.transactions || []).map((tx: any) => ({
        ...tx,
        beneficiary_account: tx.beneficiary_account,
        id: tx.id ?? (tx.record_id != null ? String(tx.record_id) : undefined),
      })));
      setReviewQueue(rqRes.reviewQueue || []);
      setIncomingQueue(iqRes.queue || []);
      setStats(statsRes.stats);
      setTotals(statsRes.totals || { egp_total: 0, usd_total: 0 });
      setHistoricalMetrics(histRes.metrics || []);
      if (healthRes.status === 'degraded') setDegradedMode(true);
    } catch (err) {
      console.error('Load failed:', err);
      addToast('Failed to load data. Retrying...', 'error');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [addToast]);

  // â”€â”€â”€ Realtime Subscription (replaces 30s polling) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  useEffect(() => {
    if (!session?.user?.id) return;
    if (access?.canReadAllData) return;

    loadData();
    
    const userId = session.user.id;

    const channel = supabase
      .channel(`dashboard-${userId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'transactions',
        filter: `user_id=eq.${userId}`,
      }, () => loadData(false))
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'review_queue',
        filter: `user_id=eq.${userId}`,
      }, () => loadData(false))
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'incoming_messages',
        filter: `user_id=eq.${userId}`,
      }, () => loadData(false))
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'dashboard_metrics',
        filter: `user_id=eq.${userId}`,
      }, () => loadData(false))
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [session?.user?.id, access?.canReadAllData, loadData]);

  // Fallback auto-refresh in case browser Realtime misses an event.
  useEffect(() => {
    if (!session?.user?.id) return;

    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') {
        loadData(false);
      }
    };

    const interval = window.setInterval(refreshIfVisible, 8000);
    const onVisibilityChange = () => refreshIfVisible();

    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [session?.user?.id, loadData]);

  // â”€â”€â”€ Integration Status Sync â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  useEffect(() => {
    if (!session) return;

    const checkIntegrations = async () => {
      try {
        const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` };
        
        // Google Status
        const integrationRes = await fetch('/api/integrations/status', { headers: authHeaders });
        if (integrationRes.ok) {
          const integration = await integrationRes.json();
          if (integration.connected) setGoogleConnected(true);
          if (integration.sheetId) setSheetUrl(`https://docs.google.com/spreadsheets/d/${integration.sheetId}`);
          if (integration.accessibleSheets) setAccessibleSheets(integration.accessibleSheets);
        }

        // WhatsApp Status
        if (access?.canUseIntegrations) {
          const waRes = await fetch('/api/whatsapp/status', { headers: authHeaders });
          if (waRes.ok) {
            const waData = await waRes.json();
            setWhatsappStatus(waData.status);
            setWhatsappStatusPayload(waData);
            if (waData.qr) setQrCode(waData.qr);
          }
        }
      } catch (err) {
        console.error('[App] Integration check failed:', err);
      }
    };

    checkIntegrations();

    // Socket Setup
    if (!access?.canUseIntegrations) return;

    const socket = io();
    socketRef.current = socket;
    socket.emit('join', session.user.id, session.access_token);

    socket.on('whatsapp_status_update', (state: any) => {
      console.log('[Socket] WhatsApp update:', state);
      setWhatsappStatus(state.status);
      setWhatsappStatusPayload(state);
      if (state.qr) setQrCode(state.qr);
      if (state.status === 'ready') {
        setQrCode(null);
        addToast('WhatsApp connected!', 'success');
      }
    });

    return () => { socket.close(); };
  }, [session, access?.canUseIntegrations, addToast]);

  useEffect(() => {
    if (!session || !access?.canUseIntegrations) return;

    let cancelled = false;
    const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` };

    const syncWhatsappStatus = async () => {
      try {
        const waRes = await fetch('/api/whatsapp/status', { headers: authHeaders });
        if (!waRes.ok || cancelled) return;

        const waData = await waRes.json();
        if (cancelled) return;

        setWhatsappStatus(waData.status);
        setWhatsappStatusPayload(waData);
        setQrCode(waData.qr || null);
      } catch {
        // Socket remains the primary realtime path; polling is a fallback for missed updates.
      }
    };

    void syncWhatsappStatus();
    const interval = window.setInterval(syncWhatsappStatus, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [session, access?.canUseIntegrations]);

  const handleConnectWhatsApp = async () => {
    if (!session) return;
    setWhatsappStatus('connecting');
    try {
      const res = await fetch('/api/whatsapp/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ userId: session.user.id }),
      });
      if (!res.ok) {
        const data = await res.json();
        addToast(data.error || 'Connection failed', 'error');
        setWhatsappStatus('disconnected');
      }
    } catch (err: any) {
      addToast(err.message, 'error');
      setWhatsappStatus('disconnected');
    }
  };

  const handleDisconnectWhatsApp = async () => {
    if (!session) return;
    try {
      const res = await fetch('/api/whatsapp/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ userId: session.user.id }),
      });
      if (res.ok) {
        setWhatsappStatus('disconnected');
        setWhatsappStatusPayload(null);
        addToast('WhatsApp disconnected.', 'info');
      }
    } catch (err: any) {
      addToast(err.message, 'error');
    }
  };

  // â”€â”€â”€ Auth Actions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const handleLogin = async () => {
    setAuthStatus('Starting Google connection...');
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        queryParams: { access_type: 'offline', prompt: 'consent' },
        redirectTo: window.location.origin,
        scopes: [
          'https://www.googleapis.com/auth/drive.file',
          'https://www.googleapis.com/auth/spreadsheets',
          'https://www.googleapis.com/auth/userinfo.profile',
        ].join(' '),
      },
    });
    if (error) {
      const msg = error.message.includes('provider is not enabled')
        ? 'Google provider not enabled in Supabase Dashboard -> Authentication -> Providers -> Google'
        : `OAuth Error: ${error.message}`;
      setAuthStatus(msg);
    } else {
      setAuthStatus('Redirecting to Google...');
    }
  };

  const handleLogout = () => supabase.auth.signOut();

  // â”€â”€â”€ Review Queue Actions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const handleReviewAction = useCallback(async (
    itemId: string,
    action: 'approve' | 'reject' | 'edit',
    corrected?: any,
    comment?: string
  ) => {
    if (!session) return;
    try {
      const res = await fetch(`/api/review/${itemId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ action, corrected_data: corrected, comment, userId: session.user.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Action failed');

      addToast(
        action === 'reject' ? 'Transaction rejected.' : 'Transaction approved and saved.',
        action === 'reject' ? 'info' : 'success'
      );
      setSelectedReviewItem(null);
      setReviewQueue(prev => prev.filter(i => i.id !== itemId));
      if (action === 'approve' || action === 'edit') {
        setTab('transactions');
      }
      void loadData(false);
    } catch (err: any) {
      addToast(`Failed: ${err.message}`, 'error');
    }
  }, [session, addToast, loadData]);

  const handleTransactionEdit = useCallback(async (recordId: string | number, updates: any, comment?: string) => {
    if (!session) return;
    try {
      const payload = {
        updates: {
          ...updates,
          amount: updates.amount === '' ? null : Number(updates.amount),
        },
        comment,
      };

      const res = await fetch(`/api/transactions/${recordId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Transaction update failed');

      addToast('Transaction updated successfully.', 'success');
      setSelectedTransactionEdit(null);
      void loadData(false);
    } catch (err: any) {
      addToast(`Failed: ${err.message}`, 'error');
    }
  }, [session, addToast, loadData]);

  // â”€â”€â”€ Derived State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const updateTransactionFilter = useCallback((key: keyof TransactionFilters, value: string) => {
    setTransactionFilters(prev => ({ ...prev, [key]: value }));
    setPage(0);
  }, []);

  const clearTransactionFilters = useCallback(() => {
    setTransactionFilters(EMPTY_TRANSACTION_FILTERS);
    setSearch('');
    setPage(0);
  }, []);

  const filteredTransactions = useMemo(() => {
    const s = search.toLowerCase();
    return transactions.filter(tx =>
      (!s || [
        tx.sender_name,
        tx.beneficiary_name,
        tx.client_name,
        tx.reference_number,
        tx.bank_name,
        tx.transaction_type,
        tx.channel,
      ].some(value => String(value || '').toLowerCase().includes(s))) &&
      (!transactionFilters.dateFrom || String(tx.transaction_date || tx.created_at).slice(0, 10) >= transactionFilters.dateFrom) &&
      (!transactionFilters.dateTo || String(tx.transaction_date || tx.created_at).slice(0, 10) <= transactionFilters.dateTo) &&
      (!transactionFilters.type || String(tx.transaction_type || '') === transactionFilters.type) &&
      (!transactionFilters.bank || normalizeBankName(tx.bank_name) === transactionFilters.bank) &&
      (!transactionFilters.status || String(tx.processing_status || '') === transactionFilters.status) &&
      (!transactionFilters.currency || String(tx.currency || '') === transactionFilters.currency) &&
      (!transactionFilters.sender || String(tx.sender_name || '').toLowerCase().includes(transactionFilters.sender.toLowerCase())) &&
      (!transactionFilters.receiver || [tx.beneficiary_name, tx.client_name].some(value => String(value || '').toLowerCase().includes(transactionFilters.receiver.toLowerCase())))
    );
  }, [transactions, search, transactionFilters]);

  const transactionFilterOptions = useMemo(() => ({
    types: Array.from(new Set(transactions.map(tx => String(tx.transaction_type || '')).filter(Boolean))).sort(),
    banks: Array.from(new Set(transactions.map(tx => normalizeBankName(tx.bank_name)).filter(Boolean))).sort(),
    statuses: Array.from(new Set(transactions.map(tx => String(tx.processing_status || '')).filter(Boolean))).sort(),
    currencies: Array.from(new Set(transactions.map(tx => String(tx.currency || '')).filter(Boolean))).sort(),
  }), [transactions]);

  const bankSummaries = useMemo(() => {
    const summaries = new Map<string, { bank: string; total: number; currency: string; count: number }>();

    for (const tx of filteredTransactions) {
      const bank = normalizeBankName(tx.bank_name);
      const currency = tx.currency || 'EGP';
      const current = summaries.get(bank) || { bank, total: 0, currency, count: 0 };
      const amount = Number(tx.amount) || 0;
      current.total += Math.abs(amount);
      current.count += 1;
      summaries.set(bank, current);
    }

    return Array.from(summaries.values()).sort((a, b) => b.total - a.total);
  }, [filteredTransactions]);

  const receiverSummaries = useMemo(() => buildReceiverSummaries(filteredTransactions), [filteredTransactions]);
  const pendingIncomingItems = useMemo(
    () => incomingQueue.filter(item => item.processing_status === 'pending'),
    [incomingQueue]
  );
  const actionablePendingCount = reviewQueue.length + pendingIncomingItems.length;

  const paginatedTransactions = useMemo(() =>
    filteredTransactions.slice(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE),
    [filteredTransactions, page]
  );
  const totalPages = Math.ceil(filteredTransactions.length / ITEMS_PER_PAGE);
  const canSeeReview = !!access?.canReview;
  const canSeeQueue = !!access?.canReview;
  const canSeeIntegrations = access?.role === 'manager';
  const canEditTransactions = !!access?.canEditAllData;

  const openPendingItems = useCallback(() => {
    if (reviewQueue.length > 0 && canSeeReview) {
      setTab('review');
      return;
    }

    if (pendingIncomingItems.length > 0 && canSeeQueue) {
      setTab('queue');
      return;
    }

    addToast('No pending items are available right now.', 'info');
  }, [reviewQueue.length, canSeeReview, pendingIncomingItems.length, canSeeQueue, addToast]);

  useEffect(() => {
    if (page > 0 && totalPages > 0 && page >= totalPages) {
      setPage(totalPages - 1);
    }
  }, [page, totalPages]);

  useEffect(() => {
    if (tab === 'review' && !canSeeReview) setTab('transactions');
    if (tab === 'queue' && !canSeeQueue) setTab('transactions');
    if (tab === 'integrations' && !canSeeIntegrations) setTab('transactions');
  }, [tab, canSeeReview, canSeeQueue, canSeeIntegrations]);

  // â”€â”€â”€ Badges â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const statusBadge = (status: string) => {
    switch (status) {
      case 'completed':
      case 'completed_transaction':
        return <span className="badge-pill badge-completed"><Check size={10} style={{ marginRight: '4px' }} />Completed</span>;
      case 'pending_review':
      case 'review_required':
        return <span className="badge-pill badge-pending"><AlertCircle size={10} style={{ marginRight: '4px' }} />Review</span>;
      case 'duplicate':
      case 'completed_duplicate':
        return <span className="badge-pill badge-duplicate"><X size={10} style={{ marginRight: '4px' }} />Duplicate</span>;
      default: return <span className="badge-pill">{status}</span>;
    }
  };

  const typeBadge = (type: string) => {
    switch (type) {
      case 'transfer': return <span className="badge-pill badge-transfer">Transfer</span>;
      case 'deposit': return <span className="badge-pill badge-deposit">Deposit</span>;
      case 'instapay': return <span className="badge-pill" style={{ background: 'rgba(168,85,247,0.15)', color: '#a855f7', border: '1px solid rgba(168,85,247,0.3)' }}>InstaPay</span>;
      default: return <span className="badge-pill">{type || '-'}</span>;
    }
  };

  // â”€â”€â”€ Loading / Auth States â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (loading) {
    return (
      <div className="loading">
        <div className="spinner" /> Booting Dashboard...
      </div>
    );
  }

  if (!session) {
    return (
      <div className="app login-screen" style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh',
        backgroundImage: 'url(/login-bg.png)', // Fixed C2: use public asset, not hardcoded path
        backgroundSize: 'cover', backgroundPosition: 'center',
      }}>
        <div className="stat-card glass animate-fade-in" style={{ padding: '3rem', textAlign: 'center', maxWidth: '440px' }}>
          <div style={{ padding: '24px', background: 'rgba(99,102,241,0.1)', borderRadius: '24px', display: 'inline-block', marginBottom: '1.5rem', border: '1px solid rgba(99,102,241,0.2)' }}>
            <Wallet size={48} color="var(--accent)" />
          </div>
          <h1 style={{ marginBottom: '0.75rem', fontSize: '1.75rem' }}>Financial Dashboard</h1>
          <div style={{ fontSize: '0.7rem', color: 'var(--muted)', marginBottom: '1.5rem', letterSpacing: '0.1em' }}>v2.0 - Production</div>
          <p style={{ color: 'var(--muted)', marginBottom: '2.5rem', lineHeight: '1.6' }}>
            AI-powered WhatsApp financial transaction extraction and management platform.
          </p>
          <button
            onClick={handleLogin}
            className="tab active"
            style={{
              padding: '14px 28px', fontSize: '1rem', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: '0.75rem',
              width: '100%', justifyContent: 'center', border: 'none',
              background: 'linear-gradient(135deg, var(--accent), var(--accent2))',
              color: 'white', borderRadius: '12px', fontWeight: 600,
              boxShadow: '0 4px 15px rgba(99,102,241,0.3)',
            }}
          >
            Sign in with Google
          </button>
          {authStatus && (
            <div style={{ marginTop: '1.5rem', padding: '12px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '10px', fontSize: '0.8rem', color: '#f87171' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'center', marginBottom: '4px' }}>
                <AlertCircle size={14} /> <strong>Auth Message</strong>
              </div>
              {authStatus}
            </div>
          )}
        </div>
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      </div>
    );
  }

  // â”€â”€â”€ Main Dashboard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  return (
    <div className="app">
      <header className="header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flex: 1 }}>
          <div style={{ padding: '8px', background: 'var(--surface2)', borderRadius: '10px' }}>
            <Wallet size={24} color="var(--accent)" />
          </div>
          <div>
            <h1>Financial Dashboard</h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '2px' }}>
              <span className="badge">{session.user.email}</span>
              {access && <span className="badge" style={{ background: 'var(--surface2)', color: 'var(--text)' }}>{access.role.toUpperCase()}</span>}
              {refreshing && <RefreshCw size={12} className="spinner" style={{ color: 'var(--accent)' }} />}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div style={{ position: 'relative' }}>
            <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
            <input
              type="text" placeholder="Search..."
              value={search} onChange={e => { setSearch(e.target.value); setPage(0); }}
              style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '8px 12px 8px 36px', color: 'var(--text)', fontSize: '0.875rem', width: '200px' }}
            />
          </div>
          <button onClick={() => setTheme(t => t === 'light' ? 'dark' : 'light')} title="Toggle Theme" style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {theme === 'light' ? <Moon size={20} /> : <Sun size={20} />}
          </button>
          <button onClick={handleLogout} title="Logout" style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <LogOut size={20} />
          </button>
        </div>
      </header>

      <main className="main animate-fade-in">
        {degradedMode && (
          <div style={{ marginBottom: '1.5rem', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: '12px', padding: '1rem', color: '#f59e0b', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <AlertCircle size={24} />
            <div>
              <strong style={{ display: 'block', fontSize: '1rem' }}>Degraded Performance Mode Active</strong>
              <span style={{ fontSize: '0.85rem' }}>Some backend infrastructure is unavailable. WhatsApp auto-restore & media ingestion may fail. The system is operating in a limited capacity.</span>
            </div>
          </div>
        )}

        {tab !== 'integrations' && (
          <>
            {/* Charts + Totals */}
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '1.5rem', marginBottom: '2rem' }}>
              <div className="stat-card glass" style={{ height: '300px', display: 'flex', flexDirection: 'column' }}>
                <div className="section-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <TrendingUp size={16} color="var(--accent)" />
                    <h2>Daily Volume (7d)</h2>
                  </div>
                </div>
                <div style={{ flex: 1, marginTop: '1rem' }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={historicalMetrics}>
                      <defs>
                        <linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.8} />
                          <stop offset="100%" stopColor="var(--accent2)" stopOpacity={0.4} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                      <XAxis dataKey="date" stroke="var(--muted)" fontSize={10} tickFormatter={(val) => val.split('-').slice(1).join('/')} />
                      <YAxis stroke="var(--muted)" fontSize={10} allowDecimals={false} />
                      <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '12px' }} itemStyle={{ color: 'var(--accent)' }} />
                      <Bar dataKey="successful_extractions" radius={[4, 4, 0, 0]}>
                        {historicalMetrics.map((_e, i) => <Cell key={i} fill="url(#barGradient)" />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div className="stat-card glass" style={{ flex: 1 }}>
                  <div className="label">Total EGP Volume</div>
                  <div className="value" style={{ color: 'var(--accent2)' }}>{totals.egp_total.toLocaleString()}</div>
                  <div className="sub">All-time</div>
                </div>
                <div className="stat-card glass" style={{ flex: 1 }}>
                  <div className="label">Total USD Volume</div>
                  <div className="value" style={{ color: '#a78bfa' }}>${totals.usd_total.toLocaleString()}</div>
                  <div className="sub">All-time</div>
                </div>
              </div>
            </div>

            {/* Stats Grid */}
            <div className="stats-grid">
              <div className="stat-card glass">
                <div className="label">Total Messages</div>
                <div className="value">{stats?.total_messages ?? 0}</div>
              </div>
              <div className="stat-card glass">
                <div className="label">Success Rate</div>
                <div className="value" style={{ color: 'var(--green)' }}>
                  {/* Fixed M5: show 0% not 100% on empty state */}
                  {stats && stats.total_messages > 0
                    ? `${Math.round((stats.successful_extractions / stats.total_messages) * 100)}%`
                    : '-'}
                </div>
              </div>
              <div
                className="stat-card glass"
                onClick={openPendingItems}
                style={{ cursor: (reviewQueue.length > 0 || pendingIncomingItems.length > 0) ? 'pointer' : 'default' }}
              >
                <div className="label">Pending Actions</div>
                <div className="value" style={{ color: 'var(--yellow)' }}>{actionablePendingCount}</div>
                <div className="sub">
                  {reviewQueue.length > 0
                    ? 'Click to open review items.'
                    : pendingIncomingItems.length > 0
                      ? 'Click to inspect pending queue items.'
                      : 'No pending actions right now.'}
                </div>
              </div>
              <div className="stat-card glass">
                <div className="label">Duplicates</div>
                <div className="value" style={{ color: 'var(--red)' }}>{stats?.duplicates ?? 0}</div>
              </div>
            </div>
          </>
        )}

        {/* Tabs */}
        <div className="tabs">
          <button className={`tab ${tab === 'transactions' ? 'active' : ''}`} onClick={() => setTab('transactions')}>
            <Check size={14} /> Transactions
            {filteredTransactions.length > 0 && <span style={{ marginLeft: '6px', background: 'rgba(99,102,241,0.2)', borderRadius: '10px', padding: '1px 7px', fontSize: '0.7rem' }}>{filteredTransactions.length}</span>}
          </button>
          {canSeeReview && (
            <button className={`tab ${tab === 'review' ? 'active' : ''}`} onClick={() => setTab('review')}>
              <AlertCircle size={14} /> Review
              {reviewQueue.length > 0 && <span style={{ marginLeft: '6px', background: 'rgba(245,158,11,0.2)', color: 'var(--yellow)', borderRadius: '10px', padding: '1px 7px', fontSize: '0.7rem' }}>{reviewQueue.length}</span>}
            </button>
          )}
          {canSeeQueue && (
            <button className={`tab ${tab === 'queue' ? 'active' : ''}`} onClick={() => setTab('queue')}>
              <Clock size={14} /> Queue
              {incomingQueue.some(i => i.processing_status.includes('failed')) && <span style={{ marginLeft: '6px', width: '8px', height: '8px', background: 'var(--red)', borderRadius: '50%' }} />}
            </button>
          )}
          {canSeeIntegrations && (
            <button className={`tab ${tab === 'integrations' ? 'active' : ''}`} onClick={() => setTab('integrations')}>
              <Settings size={14} /> Integrations
            </button>
          )}
        </div>

        {/* Transactions Tab */}
        {tab === 'transactions' && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', marginBottom: '1rem' }}>
              {bankSummaries.length === 0 ? (
                <div className="stat-card glass" style={{ padding: '1rem' }}>
                  <div className="label">Bank Summary</div>
                  <div className="sub">No filtered transactions available.</div>
                </div>
              ) : bankSummaries.map(summary => (
                <div key={summary.bank} className="stat-card glass" style={{ padding: '1rem' }}>
                  <div className="label">{summary.bank}</div>
                  <div style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--green)', marginBottom: '0.35rem' }}>
                    Total Balance {summary.total.toLocaleString()} {summary.currency}
                  </div>
                  <div className="sub">All filtered transactions are shown as positive balance totals.</div>
                  <div className="sub">{summary.count} transactions</div>
                </div>
              ))}
            </div>

            <div className="stat-card glass" style={{ padding: '1rem', marginBottom: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', gap: '1rem', flexWrap: 'wrap' }}>
                <div>
                  <div className="label">Transaction Filters</div>
                  <div className="sub">Date, type, bank, status, sender, and receiver filters.</div>
                </div>
                <button onClick={clearTransactionFilters} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '8px 12px', color: 'var(--text)', cursor: 'pointer' }}>
                  Clear Filters
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.75rem' }}>
                <input type="date" value={transactionFilters.dateFrom} onChange={e => updateTransactionFilter('dateFrom', e.target.value)} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '9px 10px', color: 'var(--text)' }} />
                <input type="date" value={transactionFilters.dateTo} onChange={e => updateTransactionFilter('dateTo', e.target.value)} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '9px 10px', color: 'var(--text)' }} />
                <select value={transactionFilters.type} onChange={e => updateTransactionFilter('type', e.target.value)} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '9px 10px', color: 'var(--text)' }}>
                  <option value="">All Types</option>
                  {transactionFilterOptions.types.map(type => <option key={type} value={type}>{type}</option>)}
                </select>
                <select value={transactionFilters.bank} onChange={e => updateTransactionFilter('bank', e.target.value)} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '9px 10px', color: 'var(--text)' }}>
                  <option value="">All Banks</option>
                  {transactionFilterOptions.banks.map(bank => <option key={bank} value={bank}>{bank}</option>)}
                </select>
                <select value={transactionFilters.status} onChange={e => updateTransactionFilter('status', e.target.value)} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '9px 10px', color: 'var(--text)' }}>
                  <option value="">All Statuses</option>
                  {transactionFilterOptions.statuses.map(status => <option key={status} value={status}>{status}</option>)}
                </select>
                <select value={transactionFilters.currency} onChange={e => updateTransactionFilter('currency', e.target.value)} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '9px 10px', color: 'var(--text)' }}>
                  <option value="">All Currencies</option>
                  {transactionFilterOptions.currencies.map(currency => <option key={currency} value={currency}>{currency}</option>)}
                </select>
                <input type="text" placeholder="Sender" value={transactionFilters.sender} onChange={e => updateTransactionFilter('sender', e.target.value)} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '9px 10px', color: 'var(--text)' }} />
                <input type="text" placeholder="Receiver / Company" value={transactionFilters.receiver} onChange={e => updateTransactionFilter('receiver', e.target.value)} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '9px 10px', color: 'var(--text)' }} />
              </div>
            </div>
            <div className="table-wrap">
              {paginatedTransactions.length === 0 ? (
                <div className="empty">{search ? 'No transactions match your search.' : 'No transactions yet. Connect WhatsApp to start ingesting data.'}</div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: '130px', whiteSpace: 'nowrap' }}>Date</th><th>Type</th><th>Sender</th><th>Receivers</th><th>Bank / Channel</th><th>Reference</th><th>Amount</th><th>Status</th>{canEditTransactions && <th>Action</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedTransactions.map(tx => (
                      <tr key={getTransactionRowKey(tx)}>
                        <td style={{ color: 'var(--muted)', fontSize: '0.75rem', whiteSpace: 'nowrap', minWidth: '130px' }}>{tx.transaction_date || tx.created_at.split('T')[0]}</td>
                        <td>{typeBadge(tx.transaction_type)}</td>
                        <td>
                          <div style={{ fontWeight: 600 }}>{tx.sender_name || 'Unknown'}</div>
                        </td>
                        <td>
                          <div style={{ fontWeight: 600 }}>{tx.beneficiary_name || '—'}</div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>{tx.client_name || '—'}</div>
                        </td>
                        <td>
                          <div>{tx.bank_name || '—'}</div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>{tx.channel || '—'}</div>
                        </td>
                        <td style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
                          {tx.reference_number || '—'}
                        </td>
                        <td style={{ fontWeight: 700, color: tx.amount > 1000 ? 'var(--accent2)' : 'inherit' }}>
                          {tx.amount?.toLocaleString()} {tx.currency}
                        </td>
                        <td>{statusBadge(tx.processing_status)}</td>
                        {canEditTransactions && (
                          <td>
                            <button
                              onClick={() => setSelectedTransactionEdit(tx)}
                              style={{ background: 'none', border: '1px solid var(--border)', borderRadius: '6px', padding: '4px 8px', color: 'var(--accent)', cursor: 'pointer', fontSize: '0.75rem' }}
                            >
                              Edit
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            {/* Pagination */}
            {totalPages > 1 && (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '1rem', marginTop: '1rem' }}>
                <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                  style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '6px 12px', color: page === 0 ? 'var(--muted)' : 'var(--text)', cursor: page === 0 ? 'default' : 'pointer' }}>
                  <ChevronLeft size={16} />
                </button>
                <span style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>Page {page + 1} of {totalPages}</span>
                <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
                  style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '6px 12px', color: page >= totalPages - 1 ? 'var(--muted)' : 'var(--text)', cursor: page >= totalPages - 1 ? 'default' : 'pointer' }}>
                  <ChevronRight size={16} />
                </button>
              </div>
            )}

            <div className="stat-card glass" style={{ padding: '1rem', marginTop: '1rem' }}>
              <div style={{ marginBottom: '0.75rem' }}>
                <div className="label">Receiver Total Balances</div>
                <div className="sub">Similar receiver/company names are grouped into one row.</div>
              </div>
              {receiverSummaries.length === 0 ? (
                <div className="sub">No receiver totals available for the current filters.</div>
              ) : (
                <div className="table-wrap" style={{ marginBottom: 0 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Receiver</th><th>Aliases</th><th>Total Balance</th><th>Count</th>
                      </tr>
                    </thead>
                    <tbody>
                      {receiverSummaries.map(summary => (
                        <tr key={summary.key}>
                          <td style={{ fontWeight: 600 }}>{summary.label}</td>
                          <td style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>{summary.aliases.length > 0 ? summary.aliases.join(' | ') : '-'}</td>
                          <td style={{ fontWeight: 700, color: 'var(--green)' }}>
                            {summary.total.toLocaleString()} {summary.currency}
                          </td>
                          <td>{summary.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}

        {/* Review Tab */}
        {tab === 'review' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: '1rem' }}>
            {reviewQueue.length === 0 ? (
              <div className="empty" style={{ gridColumn: '1/-1' }}>
                <Check size={24} color="var(--green)" style={{ marginBottom: '0.5rem' }} />
                <br />Review queue is clear!
              </div>
            ) : reviewQueue.map(item => (
              <div key={item.id} className="queue-card">
                <div style={{ flex: 1 }}>
                  <div className="q-reason">Ambiguous / Low Confidence Transaction</div>
                  <div className="q-msg">{item.raw_text || '(no raw text)'}</div>
                  {item.suggested_data?.amount && (
                    <div style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: 'var(--muted)' }}>
                      Suggested: <strong style={{ color: 'var(--text)' }}>{item.suggested_data.amount} {item.suggested_data.currency || 'EGP'}</strong>
                      {item.suggested_data.sender_name && <> | {item.suggested_data.sender_name}</>}
                    </div>
                  )}
                  <div style={{ marginTop: '0.5rem' }}>
                    <div className="conf-bar">
                      <div className="conf-fill" style={{ width: `${(item.suggested_data?.confidence || 0.3) * 100}%` }} />
                    </div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--muted)', marginTop: '3px' }}>
                      Confidence: {Math.round((item.suggested_data?.confidence || 0.3) * 100)}%
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
                  <button
                    onClick={() => handleReviewAction(item.id, 'approve')}
                    className="tab active"
                    style={{ padding: '6px 12px', fontSize: '0.8rem', background: 'rgba(34,197,94,0.15)', borderColor: 'rgba(34,197,94,0.35)', color: '#22c55e' }}
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => setSelectedReviewItem(item)}
                    className="tab"
                    style={{ padding: '6px 12px', fontSize: '0.8rem' }}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleReviewAction(item.id, 'reject')}
                    className="tab"
                    style={{ padding: '6px 12px', fontSize: '0.8rem', background: 'rgba(239,68,68,0.08)', borderColor: 'rgba(239,68,68,0.3)', color: '#ef4444' }}
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Queue Tab */}
        {tab === 'queue' && (
          <div className="table-wrap">
            {pendingIncomingItems.length > 0 && (
              <div style={{ padding: '0.9rem 1rem', borderBottom: '1px solid var(--border)', color: 'var(--muted)', fontSize: '0.85rem' }}>
                {pendingIncomingItems.length} pending message{pendingIncomingItems.length === 1 ? '' : 's'} in processing.
                Use <strong style={{ color: 'var(--text)' }}>Inspect</strong> to see the message details.
                If a message needs your action, it will move to the <strong style={{ color: 'var(--text)' }}>Review</strong> tab.
              </div>
            )}
            {incomingQueue.length === 0 ? (
              <div className="empty">No messages in the processing queue.</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Received At</th><th>Stage</th><th>Status</th><th>Attempts</th><th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {incomingQueue.map(item => (
                    <tr key={item.id}>
                      <td style={{ color: 'var(--muted)', fontSize: '0.75rem' }}>{new Date(item.received_at).toLocaleString()}</td>
                      <td style={{ fontWeight: 600, textTransform: 'uppercase', fontSize: '0.75rem' }}>{item.processing_stage}</td>
                      <td>
                        <span className={`badge-pill ${item.processing_status.includes('failed') ? 'badge-duplicate' : (item.processing_status === 'pending' ? 'badge-pending' : 'badge-completed')}`}>
                          {item.processing_status}
                        </span>
                      </td>
                      <td>{item.attempt_count}</td>
                      <td>
                        <button onClick={() => setSelectedInspectId(item.id)} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: '6px', padding: '4px 8px', color: 'var(--accent)', cursor: 'pointer', fontSize: '0.75rem' }}>
                          Inspect
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* Integrations Tab */}
        {tab === 'integrations' && (
          <Integrations
            user={session.user}
            token={session.access_token}
            onConnectGoogle={handleLogin}
            onToast={addToast}
            role={access?.role || 'viewer'}
            accessibleSheets={accessibleSheets}
            // New persistent props
            googleConnected={googleConnected}
            sheetUrl={sheetUrl}
            whatsappStatus={whatsappStatus}
            whatsappStatusPayload={whatsappStatusPayload}
            qrCode={qrCode}
            onConnectWhatsApp={handleConnectWhatsApp}
            onDisconnectWhatsApp={handleDisconnectWhatsApp}
          />
        )}
      </main>

      {/* Review Modal */}
      {selectedReviewItem && (
        <ReviewModal
          item={selectedReviewItem}
          token={session?.access_token || ''}
          onClose={() => setSelectedReviewItem(null)}
          requireComment={!!access?.mustProvideChangeReason}
          onAction={(action, corrected, comment) => handleReviewAction(selectedReviewItem.id, action, corrected, comment)}
        />
      )}

      {selectedTransactionEdit && (
        <TransactionEditModal
          item={selectedTransactionEdit}
          onClose={() => setSelectedTransactionEdit(null)}
          onSave={(updates, comment) => handleTransactionEdit(selectedTransactionEdit.record_id || selectedTransactionEdit.id || '', updates, comment)}
        />
      )}

      {selectedInspectId && (
        <InspectorModal
          id={selectedInspectId}
          token={session?.access_token || ''}
          onClose={() => setSelectedInspectId(null)}
        />
      )}

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
