/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
export type ApiResponse<T = unknown> = {
  success: boolean
  message?: string
  data?: T
}

export type MatchMode = 'exact' | 'contains' | 'regex'

export type DetectedModelSetting = {
  model: string
  question: string
  expected_answer: string
  match_mode: MatchMode
  retry_times: number
  excluded_channel_ids: number[]
}

export type ActionType =
  | 'add_group'
  | 'remove_group'
  | 'increase_priority'
  | 'decrease_priority'
  | 'set_priority'
  | 'increase_weight'
  | 'decrease_weight'
  | 'set_weight'
  | 'auto_disable'
  | 'manual_disable'
  | 'set_tag'
  | 'remove_tag'

/** One step of an action list. `value` is a group or tag; `amount` a number. */
export type DetectionAction = {
  type: ActionType
  value: string
  amount: number
}

export type AppliedAction = DetectionAction & {
  changed: boolean
}

/**
 * Interval override for runs that finish between `start` (inclusive) and
 * `end` (exclusive), HH:MM in server time. An end earlier than the start
 * runs past midnight.
 */
export type IntervalWindow = {
  start: string
  end: string
  interval_minutes: number
}

export type ModelReplacementSettings = {
  enabled: boolean
  /** Default interval, used outside every window. */
  interval_minutes: number
  interval_windows: IntervalWindow[]
  rounds: number
  concurrency: number
  timeout_seconds: number
  threshold: number
  pass_actions: DetectionAction[]
  fail_actions: DetectionAction[]
  request_failure_actions: DetectionAction[]
  models: DetectedModelSetting[]
}

export type DetectionChannel = {
  id: number
  name: string
  type: number
  status: number
  groups: string[]
}

export type ModelCandidate = {
  model: string
  channels: DetectionChannel[]
}

export type Verdict = 'passed' | 'replaced' | 'failed'

export type ModelStat = {
  model: string
  total: number
  matched: number
  mismatched: number
  failed: number
  match_percent: number
  mismatch_percent: number
  verdict: Verdict | ''
}

export type DetectionRecord = {
  id: number
  run_id: string
  channel_id: number
  channel_name: string
  verdict: Verdict
  match_percent: number
  actions: AppliedAction[]
  error_message: string
  avg_latency_ms: number
  started_at: number
  finished_at: number
  created_at: number
  models: ModelStat[]
}

export type DetectionAttempt = {
  id: number
  record_id: number
  model: string
  round: number
  tries: number
  success: boolean
  matched: boolean
  answer: string
  error_message: string
  latency_ms: number
  tested_at: number
}

export type DetectionRunSummary = {
  started_at: number
  finished_at: number
  manual: boolean
  channels: number
  passed: number
  replaced: number
  failed: number
}

export type DetectionRun = {
  task_id: string
  status: 'pending' | 'running' | 'succeeded' | 'failed'
  error: string
  created_at: number
  updated_at: number
  state?: { processed?: number; total?: number; progress?: number } | null
  result?: DetectionRunSummary | null
}

export type SettingsResponse = {
  settings: ModelReplacementSettings
  /** Time zone the interval windows are evaluated in, e.g. "UTC+08:00 (CST)". */
  server_time_zone: string
}

export type DetectionOverview = {
  enabled: boolean
  interval_minutes: number
  /** Interval that applies after the latest run, from its finish time. */
  next_interval_minutes: number
  rounds: number
  models: string[]
  last_run: DetectionRun | null
  active_run: DetectionRun | null
  next_run_at: number | null
}

export type DetectionChannelRow = DetectionChannel & {
  in_scope: boolean
  latest: DetectionRecord | null
}

export type RecordAttempts = {
  record: DetectionRecord
  attempts: DetectionAttempt[]
}
