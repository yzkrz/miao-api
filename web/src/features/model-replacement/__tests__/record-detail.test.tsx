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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { RecordDetail } from '../components/report/record-detail'
import type { RecordAttempts } from '../types'

const clients: QueryClient[] = []
const mismatchReason =
  'The response model does not exactly match the test model.'

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})

it.each([
  {
    success: true,
    reason: mismatchReason,
    label: 'Response model mismatched',
    answer: 'expected answer',
  },
  {
    success: true,
    reason: '',
    label: 'Answer mismatched',
    answer: 'wrong answer',
  },
  {
    success: false,
    reason: 'upstream unavailable',
    label: 'Request failed',
    answer: '',
  },
])(
  'shows $label with its original reply or failure reason',
  async (testCase) => {
    const data: RecordAttempts = {
      record: {
        id: 1,
        run_id: 'run-1',
        channel_id: 7,
        channel_name: 'upstream',
        verdict: testCase.success ? 'replaced' : 'failed',
        match_percent: 0,
        actions: [],
        error_message: '',
        models: [],
        avg_latency_ms: 12,
        started_at: 1_700_000_000,
        finished_at: 1_700_000_001,
        created_at: 1_700_000_001,
      },
      attempts: [
        {
          id: 1,
          record_id: 1,
          model: 'gpt-6-astra',
          round: 1,
          tries: 1,
          success: testCase.success,
          matched: false,
          answer: testCase.answer,
          error_message: testCase.reason,
          latency_ms: 12,
          tested_at: 1_700_000_000,
        },
      ],
    }
    vi.spyOn(api, 'get').mockResolvedValue({ data: { success: true, data } })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    clients.push(client)
    render(
      <QueryClientProvider client={client}>
        <RecordDetail recordId={1} onClose={() => {}} />
      </QueryClientProvider>
    )
    const attempt = await screen.findByRole('listitem')
    expect(
      within(attempt).getByText(testCase.label, { exact: true })
    ).toBeVisible()
    if (testCase.answer) expect(screen.getByText(testCase.answer)).toBeVisible()
    if (testCase.reason) expect(screen.getByText(testCase.reason)).toBeVisible()
    if (testCase.reason === mismatchReason) {
      expect(screen.queryByText('Answer mismatched')).not.toBeInTheDocument()
      expect(screen.queryByText('Request failed')).not.toBeInTheDocument()
    }
  }
)
