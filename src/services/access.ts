import type { User } from '@supabase/supabase-js';
import { supabaseAdmin } from '../lib/supabase-server';

export type AppRole = 'manager' | 'cfo' | 'admin' | 'viewer';

export interface AccessContext {
  userId: string;
  email: string;
  role: AppRole;
  canReadAllData: boolean;
  canEditAllData: boolean;
  canEditOwnData: boolean;
  canReview: boolean;
  canUseIntegrations: boolean;
  canManageSystem: boolean;
  mustProvideChangeReason: boolean;
}

const VALID_ROLES: AppRole[] = ['manager', 'cfo', 'admin', 'viewer'];

const ACCESS_SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id uuid PRIMARY KEY,
  email text UNIQUE NOT NULL,
  role text NOT NULL CHECK (role IN ('manager', 'cfo', 'admin', 'viewer')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.change_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL,
  actor_email text,
  actor_role text NOT NULL,
  target_user_id uuid,
  action text NOT NULL,
  reason text,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_change_audit_log_actor_user_id ON public.change_audit_log(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_change_audit_log_target_user_id ON public.change_audit_log(target_user_id);
CREATE INDEX IF NOT EXISTS idx_change_audit_log_entity ON public.change_audit_log(entity_type, entity_id);
`;

let schemaEnsured = false;

export function inferRoleFromEmail(email: string): AppRole {
  const normalized = email.toLowerCase();
  const managerEmail = (process.env.MANAGER_EMAIL || 'minahossam500@gmail.com').trim().toLowerCase();
  const cfoEmails = (process.env.CFO_EMAILS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (managerEmail && normalized === managerEmail) return 'manager';
  if (cfoEmails.includes(normalized)) return 'cfo';
  return 'viewer';
}

function buildAccessContext(userId: string, email: string, role: AppRole): AccessContext {
  return {
    userId,
    email,
    role,
    canReadAllData: role === 'manager' || role === 'cfo' || role === 'viewer',
    canEditAllData: role === 'manager' || role === 'cfo',
    canEditOwnData: role === 'manager' || role === 'cfo' || role === 'admin',
    canReview: role === 'manager' || role === 'cfo' || role === 'admin',
    canUseIntegrations: role === 'manager',
    canManageSystem: role === 'manager',
    mustProvideChangeReason: role === 'admin',
  };
}

function isMissingTableError(error: any) {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('user_roles') && (message.includes('does not exist') || message.includes('could not find'));
}

export async function ensureAccessSchema() {
  if (schemaEnsured) return;

  try {
    const { error } = await supabaseAdmin.rpc('execute_sql', { sql_query: ACCESS_SCHEMA_SQL });
    if (error) {
      console.warn('[Access] Schema bootstrap skipped:', error.message);
      return;
    }
    schemaEnsured = true;
  } catch (error: any) {
    console.warn('[Access] Schema bootstrap failed:', error.message || error);
  }
}

export async function getAccessContext(user: User): Promise<AccessContext> {
  const email = (user.email || '').toLowerCase();
  const fallbackRole = inferRoleFromEmail(email);

  try {
    const { data, error } = await supabaseAdmin
      .from('user_roles')
      .select('role, is_active')
      .eq('user_id', user.id)
      .maybeSingle();

    if (error) {
      if (!isMissingTableError(error)) {
        console.warn('[Access] user_roles lookup failed:', error.message);
      }
      return buildAccessContext(user.id, email, fallbackRole);
    }

    const selectedRole =
      data?.is_active && data.role && VALID_ROLES.includes(data.role as AppRole)
        ? (data.role as AppRole)
        : fallbackRole;

    if (!data) {
      await supabaseAdmin.from('user_roles').upsert(
        [{ user_id: user.id, email, role: selectedRole, is_active: true }],
        { onConflict: 'user_id' }
      );
    }

    return buildAccessContext(user.id, email, selectedRole);
  } catch (error: any) {
    console.warn('[Access] Falling back to email-based role:', error.message || error);
    return buildAccessContext(user.id, email, fallbackRole);
  }
}

export async function listUserRoles(context: AccessContext) {
  if (!context.canManageSystem) {
    throw new Error('Only manager can manage roles.');
  }

  const { data, error } = await supabaseAdmin
    .from('user_roles')
    .select('user_id, email, role, is_active, created_at, updated_at')
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

export async function upsertUserRole(context: AccessContext, email: string, role: AppRole) {
  if (!context.canManageSystem) {
    throw new Error('Only manager can assign roles.');
  }
  if (!VALID_ROLES.includes(role)) {
    throw new Error('Invalid role.');
  }

  const normalizedEmail = email.trim().toLowerCase();
  const { data: users, error: userError } = await supabaseAdmin.auth.admin.listUsers();
  if (userError) throw userError;

  const matchedUser = (users?.users || []).find((item: any) => (item.email || '').toLowerCase() === normalizedEmail);
  if (!matchedUser) {
    throw new Error('User must sign in once before a role can be assigned.');
  }

  const { error } = await supabaseAdmin.from('user_roles').upsert(
    [{
      user_id: matchedUser.id,
      email: normalizedEmail,
      role,
      is_active: true,
      updated_at: new Date().toISOString(),
    }],
    { onConflict: 'user_id' }
  );

  if (error) throw error;
}

export async function logChangeAudit(params: {
  actor: AccessContext;
  action: string;
  entityType: string;
  entityId: string;
  targetUserId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}) {
  try {
    await supabaseAdmin.from('change_audit_log').insert([{
      actor_user_id: params.actor.userId,
      actor_email: params.actor.email,
      actor_role: params.actor.role,
      target_user_id: params.targetUserId || null,
      action: params.action,
      reason: params.reason || null,
      entity_type: params.entityType,
      entity_id: params.entityId,
      metadata: params.metadata || {},
    }]);
  } catch (error: any) {
    console.warn('[Access] Failed to write change audit log:', error.message || error);
  }
}

export function requireReadAllData(context: AccessContext) {
  if (!context.canReadAllData) {
    throw new Error('Access denied.');
  }
}

export function requireRole(context: AccessContext, allowed: AppRole[]) {
  if (!allowed.includes(context.role)) {
    throw new Error('Access denied.');
  }
}
