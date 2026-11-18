import { createContext, useContext } from 'react';
import type { Role, WorkspaceKind } from './api';

export interface Me {
  id: number;
  name: string;
  email: string;
  // The role in the active workspace.
  role: Role;
  workspace_id: number;
  workspace_name: string;
  workspace_kind: WorkspaceKind;
  // The agency a client workspace belongs to.
  parent_name: string | null;
  // The agency this user runs from the active workspace (itself, or a client's parent).
  agency: { id: number; name: string } | null;
  // Optional areas switched on by the server (billing, agency).
  features: Record<string, boolean>;
}

// The signed-in user, for components deep in a page (pages that already take `me` keep using the prop).
export const MeContext = createContext<Me | null>(null);
export const useMe = () => useContext(MeContext)!;

// Clients (agency customers) have a read-only portal: every control that changes something is hidden.
export const canWrite = (me: Pick<Me, 'role'>) => me.role !== 'client';
export const isAdminRole = (me: Pick<Me, 'role'>) => me.role === 'owner' || me.role === 'admin';
