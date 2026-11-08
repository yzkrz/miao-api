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
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { OverviewCards } from '../components/report/overview-cards'
import type { DetectionOverview } from '../types'

const overview: DetectionOverview = {
  enabled: true,
  interval_minutes: 10,
  next_interval_minutes: 10,
  rounds: 3,
  models: ['model-a'],
  last_run: null,
  active_run: null,
  next_run_at: null,
}

describe('OverviewCards health share', () => {
  it('divides enabled healthy channels by every channel in scope', () => {
    render(
      <OverviewCards
        overview={overview}
        healthyCount={1}
        totalCount={6}
        isStarting={false}
        onRunNow={vi.fn()}
      />
    )
    expect(screen.getByText('17%')).toBeInTheDocument()
    expect(screen.getByText('1 healthy and enabled')).toBeInTheDocument()
    expect(
      screen.getByText('6 channels in detection scope')
    ).toBeInTheDocument()
  })

  it('shows zero percent when channels are in scope but none has passed while enabled', () => {
    render(
      <OverviewCards
        overview={overview}
        healthyCount={0}
        totalCount={2}
        isStarting={false}
        onRunNow={vi.fn()}
      />
    )
    expect(screen.getByText('0%')).toBeInTheDocument()
    expect(
      screen.getByText('2 channels in detection scope')
    ).toBeInTheDocument()
  })

  it('shows the empty scope message when no configured channel is eligible', () => {
    render(
      <OverviewCards
        overview={overview}
        healthyCount={0}
        totalCount={0}
        isStarting={false}
        onRunNow={vi.fn()}
      />
    )
    expect(
      screen.getByText('No channels are in detection scope yet.')
    ).toBeInTheDocument()
    expect(screen.queryByText('0%')).not.toBeInTheDocument()
  })
})
