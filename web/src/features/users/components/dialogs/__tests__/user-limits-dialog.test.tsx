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
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import type { UsageRuleStatus, UserLimits } from '@/lib/usage-limits'
import {
  DEFAULT_CURRENCY_CONFIG,
  useSystemConfigStore,
} from '@/stores/system-config-store'

import { UserLimitsDialog } from '../user-limits-dialog'

const exhaustedFiveHours: UsageRuleStatus = {
  window_seconds: 18000,
  quota_limit: 5_000_000,
  enabled: true,
  status: 'exhausted',
  used_quota: 5_000_000,
  window_start: 1_700_000_000,
  reset_at: 1_700_018_000,
}

const savedLimits: UserLimits = {
  max_concurrency: 2,
  current_concurrency: 1,
  updated_at: 1_700_000_000,
  usage_rules: [exhaustedFiveHours],
}

const queryClients: QueryClient[] = []

function renderDialog() {
  const onOpenChange = vi.fn()
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  queryClients.push(client)
  render(
    <QueryClientProvider client={client}>
      <UserLimitsDialog
        open
        onOpenChange={onOpenChange}
        user={{ id: 7, username: 'alice' }}
      />
    </QueryClientProvider>
  )
  return { onOpenChange }
}

function mockLoad(limits: UserLimits = savedLimits) {
  return vi.spyOn(api, 'get').mockImplementation(async (url) => ({
    data: {
      success: true,
      data: String(url).endsWith('/limits/models')
        ? [
            {
              model: 'model-alpha',
              channels: [{ id: 1, name: 'East', type: 1, groups: ['premium'] }],
            },
            {
              model: 'model-beta',
              channels: [
                { id: 2, name: 'West', type: 14, groups: ['default'] },
              ],
            },
          ]
        : limits,
    },
  }))
}

beforeEach(() => {
  useSystemConfigStore
    .getState()
    .setConfig({ currency: { ...DEFAULT_CURRENCY_CONFIG } })
})
afterEach(() => {
  queryClients.splice(0).forEach((client) => client.clear())
})

describe('UserLimitsDialog', () => {
  it('converts unsaved inputs when the configured display unit changes without changing quota', async () => {
    mockLoad()
    renderDialog()
    expect(await screen.findByLabelText('Quota (USD)')).toHaveValue(10)
    act(() =>
      useSystemConfigStore.getState().setConfig({
        currency: {
          ...DEFAULT_CURRENCY_CONFIG,
          quotaDisplayType: 'CNY',
          usdExchangeRate: 7,
        },
      })
    )
    await waitFor(() =>
      expect(screen.getByLabelText('Quota (CNY)')).toHaveValue(70)
    )
    const amount = screen.getByLabelText('Quota (CNY)')
    fireEvent.change(amount, { target: { value: '140' } })
    act(() =>
      useSystemConfigStore.getState().setConfig({
        currency: { ...DEFAULT_CURRENCY_CONFIG, quotaDisplayType: 'TOKENS' },
      })
    )
    await waitFor(() =>
      expect(screen.getByLabelText('Quota (Tokens)')).toHaveValue(10000000)
    )
    act(() =>
      useSystemConfigStore.getState().setConfig({
        currency: {
          ...DEFAULT_CURRENCY_CONFIG,
          quotaDisplayType: 'CUSTOM',
          customCurrencySymbol: '€',
          customCurrencyExchangeRate: 0.9,
        },
      })
    )
    await waitFor(() =>
      expect(screen.getByLabelText('Quota (€)')).toHaveValue(18)
    )
  })
  it('loads the saved policy and shows the current window of each saved rule', async () => {
    const get = mockLoad()

    renderDialog()

    expect(await screen.findByLabelText('Maximum concurrency')).toHaveValue(2)
    expect(get).toHaveBeenCalledWith('/api/user/7/limits')
    expect(screen.getByText('In flight now: 1')).toBeInTheDocument()
    const rules = screen.getByRole('list', { name: 'Usage limit rules' })
    expect(within(rules).getAllByRole('listitem')).toHaveLength(1)
    expect(within(rules).getByText('Exhausted')).toBeInTheDocument()
    expect(
      within(rules).getByRole('progressbar', {
        name: 'Usage limit used: 100%',
      })
    ).toBeInTheDocument()
  })

  it('saves an added rule as window seconds and quota units, then closes', async () => {
    mockLoad()
    const put = vi.spyOn(api, 'put').mockResolvedValue({
      data: { success: true, data: savedLimits },
    })
    const { onOpenChange } = renderDialog()
    await screen.findByLabelText('Maximum concurrency')

    // The new rule takes the first preset window not used yet: 1 day.
    await userEvent.click(screen.getByRole('button', { name: 'Add rule' }))
    const amounts = screen.getAllByLabelText('Quota (USD)')
    fireEvent.change(amounts[1], { target: { value: '3' } })
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/user/7/limits', {
        max_concurrency: 2,
        usage_rules: [
          { window_seconds: 18000, quota_limit: 5_000_000, enabled: true },
          { window_seconds: 86400, quota_limit: 1_500_000, enabled: true },
        ],
      })
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('keeps the sheet open and shows the field error for a rule without an amount', async () => {
    mockLoad()
    const put = vi.spyOn(api, 'put')
    const { onOpenChange } = renderDialog()
    await screen.findByLabelText('Maximum concurrency')

    await userEvent.click(screen.getByRole('button', { name: 'Add rule' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(
      await screen.findByText('Amount must be greater than 0')
    ).toBeInTheDocument()
    expect(put).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('ends a window after confirmation and shows it as not started', async () => {
    mockLoad()
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      data: {
        success: true,
        data: {
          ...savedLimits,
          usage_rules: [
            {
              ...exhaustedFiveHours,
              status: 'idle',
              used_quota: 0,
              window_start: 0,
              reset_at: 0,
            },
          ],
        },
      },
    })
    renderDialog()
    await screen.findByLabelText('Maximum concurrency')

    await userEvent.click(screen.getByRole('button', { name: 'End window' }))
    const confirm = await screen.findByRole('alertdialog')
    await userEvent.click(
      within(confirm).getByRole('button', { name: 'End window' })
    )

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/user/7/limits/reset', {
        window_seconds: 18000,
      })
    )
    expect(await screen.findByText('Not started')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'End window' })).toBeDisabled()
  })

  it('offers a retry when the policy cannot be loaded', async () => {
    let failed = false
    const get = vi.spyOn(api, 'get').mockImplementation(async (url) => {
      if (String(url).endsWith('/limits/models')) {
        return { data: { success: true, data: [] } }
      }
      if (!failed) {
        failed = true
        throw new Error('network down')
      }
      return { data: { success: true, data: savedLimits } }
    })
    renderDialog()

    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }))

    expect(await screen.findByLabelText('Maximum concurrency')).toHaveValue(2)
    expect(
      get.mock.calls.filter(([url]) => url === '/api/user/7/limits')
    ).toHaveLength(2)
  })

  it('filters by model-name prefix and saves the selected model scope', async () => {
    const user = userEvent.setup()
    mockLoad()
    const put = vi
      .spyOn(api, 'put')
      .mockResolvedValue({ data: { success: true, data: savedLimits } })
    renderDialog()
    await screen.findByLabelText('Maximum concurrency')
    await user.click(
      screen.getByRole('combobox', { name: 'Applicable models' })
    )
    await user.type(screen.getByPlaceholderText('Search models'), 'model')
    await user.click(await screen.findByRole('option', { name: 'model-alpha' }))
    expect(
      screen.getByRole('combobox', { name: 'Applicable models' })
    ).toHaveTextContent('model-alpha')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        '/api/user/7/limits',
        expect.objectContaining({
          usage_rules: [expect.objectContaining({ models: ['model-alpha'] })],
        })
      )
    )
  })

  it('opens with all models and filters model names by prefix', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockImplementation(async (url) => ({
      data: {
        success: true,
        data: String(url).endsWith('/limits/models')
          ? [
              {
                model: 'gpt-4.1',
                channels: [
                  { id: 1, name: 'East', type: 1, groups: ['premium'] },
                ],
              },
              {
                model: 'claude-3.7-sonnet',
                channels: [
                  { id: 2, name: 'West', type: 14, groups: ['default'] },
                ],
              },
              {
                model: 'vendor-gpt-4.1',
                channels: [
                  { id: 3, name: 'North', type: 1, groups: ['default'] },
                ],
              },
            ]
          : savedLimits,
      },
    }))
    renderDialog()
    await screen.findByLabelText('Maximum concurrency')
    await user.click(
      screen.getByRole('combobox', { name: 'Applicable models' })
    )

    expect(await screen.findByRole('option', { name: 'gpt-4.1' })).toBeVisible()
    expect(
      screen.getByRole('option', { name: 'claude-3.7-sonnet' })
    ).toBeVisible()
    expect(screen.getByRole('option', { name: 'vendor-gpt-4.1' })).toBeVisible()

    await user.type(screen.getByPlaceholderText('Search models'), 'gpt')
    expect(screen.getByRole('option', { name: 'gpt-4.1' })).toBeVisible()
    expect(screen.queryByRole('option', { name: 'vendor-gpt-4.1' })).toBeNull()
    expect(
      screen.queryByRole('option', { name: 'claude-3.7-sonnet' })
    ).toBeNull()

    const selectAll = screen.getByRole('checkbox', {
      name: 'Select all matching models',
    })
    await user.click(selectAll)
    expect(screen.getByRole('option', { name: 'gpt-4.1' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(
      screen.getByRole('combobox', { name: 'Applicable models' })
    ).toHaveTextContent('gpt-4.1')

    await user.clear(screen.getByPlaceholderText('Search models'))
    expect(
      screen.getByRole('checkbox', { name: 'Select all matching models' })
    ).not.toBeChecked()
    await user.click(
      screen.getByRole('checkbox', { name: 'Select all matching models' })
    )
    expect(
      screen.getByRole('checkbox', { name: 'Select all matching models' })
    ).toBeChecked()
    expect(
      screen.getByRole('combobox', { name: 'Applicable models' })
    ).toHaveTextContent('+2 more')
  })

  it('offers only the five natural periods and saves calendar-year rules', async () => {
    const user = userEvent.setup()
    mockLoad()
    const put = vi
      .spyOn(api, 'put')
      .mockResolvedValue({ data: { success: true, data: savedLimits } })
    renderDialog()
    await screen.findByLabelText('Maximum concurrency')
    await user.click(screen.getByRole('combobox', { name: 'Reset mode' }))
    await user.click(
      await screen.findByRole('option', { name: 'Calendar mode' })
    )
    expect(
      screen.getByRole('combobox', { name: 'Calendar period' })
    ).toHaveTextContent('Calendar day')
    await user.click(screen.getByRole('combobox', { name: 'Calendar period' }))
    expect(
      screen.getAllByRole('option').map((item) => item.textContent)
    ).toEqual([
      'Calendar day',
      'Calendar week',
      'Calendar month',
      'Calendar quarter',
      'Calendar year',
    ])
    await user.click(screen.getByRole('option', { name: 'Calendar year' }))
    expect(
      screen.queryByRole('combobox', { name: 'Time window' })
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        '/api/user/7/limits',
        expect.objectContaining({
          usage_rules: [
            expect.objectContaining({
              mode: 'calendar',
              calendar_period: 'year',
              window_seconds: 31536000,
            }),
          ],
        })
      )
    )
  })

  it('saves a default calendar day immediately after switching from a five-hour window', async () => {
    const user = userEvent.setup()
    mockLoad()
    const put = vi
      .spyOn(api, 'put')
      .mockResolvedValue({ data: { success: true, data: savedLimits } })
    renderDialog()
    await screen.findByLabelText('Maximum concurrency')
    await user.click(screen.getByRole('combobox', { name: 'Reset mode' }))
    await user.click(
      await screen.findByRole('option', { name: 'Calendar mode' })
    )
    expect(
      screen.getByRole('combobox', { name: 'Calendar period' })
    ).toHaveTextContent('Calendar day')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/user/7/limits', {
        max_concurrency: 2,
        usage_rules: [
          {
            mode: 'calendar',
            calendar_period: 'day',
            window_seconds: 86400,
            quota_limit: 5_000_000,
            enabled: true,
          },
        ],
      })
    )
  })

  it.each([
    { windowSeconds: 18000, windowLabel: '5 hours' },
    { windowSeconds: 43200, windowLabel: 'Custom' },
  ])(
    'preserves the $windowLabel window and calendar selection across mode switches',
    async ({ windowSeconds, windowLabel }) => {
      const user = userEvent.setup()
      mockLoad({
        ...savedLimits,
        usage_rules: [{ ...exhaustedFiveHours, window_seconds: windowSeconds }],
      })
      renderDialog()
      await screen.findByLabelText('Maximum concurrency')
      expect(
        screen.getByRole('combobox', { name: 'Time window' })
      ).toHaveTextContent(windowLabel)

      await user.click(screen.getByRole('combobox', { name: 'Reset mode' }))
      await user.click(
        await screen.findByRole('option', { name: 'Calendar mode' })
      )
      expect(
        screen.getByRole('combobox', { name: 'Calendar period' })
      ).toHaveTextContent('Calendar day')
      await user.click(
        screen.getByRole('combobox', { name: 'Calendar period' })
      )
      await user.click(
        await screen.findByRole('option', { name: 'Calendar month' })
      )

      await user.click(screen.getByRole('combobox', { name: 'Reset mode' }))
      await user.click(
        await screen.findByRole('option', { name: 'Window mode' })
      )
      expect(
        screen.getByRole('combobox', { name: 'Time window' })
      ).toHaveTextContent(windowLabel)
      if (windowLabel === 'Custom') {
        expect(
          screen.getByRole('spinbutton', { name: 'Window length' })
        ).toHaveValue(12)
        expect(
          screen.getByRole('combobox', { name: 'Unit' })
        ).toHaveTextContent('hours')
      }

      await user.click(screen.getByRole('combobox', { name: 'Reset mode' }))
      await user.click(
        await screen.findByRole('option', { name: 'Calendar mode' })
      )
      expect(
        screen.getByRole('combobox', { name: 'Calendar period' })
      ).toHaveTextContent('Calendar month')
      expect(
        screen.getByRole('spinbutton', { name: 'Quota (USD)' })
      ).toHaveValue(10)
    }
  )

  it('explains that clearing a calendar counter keeps its reset boundary', async () => {
    const user = userEvent.setup()
    mockLoad({
      ...savedLimits,
      usage_rules: [
        {
          ...exhaustedFiveHours,
          mode: 'calendar',
          calendar_period: 'day',
          window_seconds: 86400,
        },
      ],
    })
    renderDialog()
    await screen.findByLabelText('Maximum concurrency')
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Reset usage window')).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        'Clear usage for Calendar day of alice? The calendar reset time stays unchanged.'
      )
    ).toBeInTheDocument()
  })
})
