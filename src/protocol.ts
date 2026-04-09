/**
 * Type definitions matching the OpenHarness OHJSON protocol.
 * See: src/openharness/ui/protocol.py
 */

// ── Frontend → Backend (requests) ──────────────────────────────────────────

export type FrontendRequestType =
  | 'submit_line'
  | 'permission_response'
  | 'question_response'
  | 'list_sessions'
  | 'select_command'
  | 'apply_select_command'
  | 'shutdown';

export interface FrontendRequest {
  type: FrontendRequestType;
  line?: string;
  command?: string;
  value?: string;
  request_id?: string;
  allowed?: boolean;
  answer?: string;
}

// ── Backend → Frontend (events) ────────────────────────────────────────────

export type BackendEventType =
  | 'ready'
  | 'state_snapshot'
  | 'tasks_snapshot'
  | 'transcript_item'
  | 'assistant_delta'
  | 'assistant_complete'
  | 'line_complete'
  | 'tool_started'
  | 'tool_completed'
  | 'clear_transcript'
  | 'modal_request'
  | 'select_request'
  | 'todo_update'
  | 'plan_mode_change'
  | 'swarm_status'
  | 'error'
  | 'shutdown';

export interface TranscriptItem {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'tool_result' | 'log';
  text: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  is_error?: boolean;
}

export interface TaskSnapshot {
  id: string;
  type: string;
  status: string;
  description: string;
  metadata?: Record<string, string>;
}

export interface AppState {
  model: string;
  permission_mode: string;
  theme: string;
  cwd: string;
  provider: string;
  auth_status: string;
  base_url: string;
  vim_enabled: boolean;
  voice_enabled: boolean;
  fast_mode: boolean;
  effort: string;
  passes: number;
  mcp_connected: number;
  mcp_failed: number;
  bridge_sessions: number;
  output_style: string;
}

export interface BackendEvent {
  type: BackendEventType;
  message?: string;
  item?: TranscriptItem;
  state?: AppState;
  tasks?: TaskSnapshot[];
  mcp_servers?: Record<string, unknown>[];
  bridge_sessions?: Record<string, unknown>[];
  commands?: string[];
  modal?: ModalRequest;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  output?: string;
  is_error?: boolean;
  todo_markdown?: string;
  plan_mode?: string;
  select_options?: Record<string, unknown>[];
}

export interface ModalRequest {
  id: string;
  type: 'permission' | 'question';
  title: string;
  message: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}
