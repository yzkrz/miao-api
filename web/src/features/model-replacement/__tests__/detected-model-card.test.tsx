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
import userEvent from '@testing-library/user-event'
import { useForm } from 'react-hook-form'
import { describe, expect, it } from 'vitest'

import { Form } from '@/components/ui/form'

import { DetectedModelCard } from '../components/settings/detected-model-card'
import {
  DEFAULT_MODEL_REPLACEMENT_SETTINGS,
  createDetectedModel,
} from '../lib/settings-form'
import type { DetectionChannel, ModelReplacementSettings } from '../types'

const channels: DetectionChannel[] = [
  { id: 1, name: 'alpha', type: 1, status: 1, groups: ['default'] },
  { id: 2, name: 'beta', type: 1, status: 3, groups: ['default'] },
  { id: 3, name: 'gamma', type: 1, status: 2, groups: ['default'] },
]

let excludedChannelIds: number[] = []

function Harness(props: { channels?: DetectionChannel[] }) {
  const form = useForm<ModelReplacementSettings>({
    defaultValues: {
      ...DEFAULT_MODEL_REPLACEMENT_SETTINGS,
      models: [createDetectedModel('gpt-4o')],
    },
  })
  excludedChannelIds = form.watch('models.0.excluded_channel_ids')
  return (
    <Form {...form}>
      <DetectedModelCard
        index={0}
        model='gpt-4o'
        channels={props.channels ?? channels}
        control={form.control}
        onRemove={() => undefined}
      />
    </Form>
  )
}

describe('DetectedModelCard channel list', () => {
  it('checks only enabled channels and leaves disabled channels unchecked', () => {
    render(<Harness />)

    const enabled = screen.getByRole('checkbox', { name: /alpha/ })
    const autoDisabled = screen.getByRole('checkbox', { name: /beta/ })

    expect(enabled).toBeChecked()
    expect(enabled).toBeEnabled()
    expect(autoDisabled).toHaveAttribute('aria-disabled', 'true')
    expect(autoDisabled).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /gamma/ })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /gamma/ })).toHaveAttribute(
      'aria-disabled',
      'true'
    )
    expect(screen.getByText('1 of 3 selected')).toBeInTheDocument()
  })

  it('records an unchecked channel as excluded', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('checkbox', { name: /alpha/ }))

    expect(screen.getByRole('checkbox', { name: /alpha/ })).not.toBeChecked()
    expect(excludedChannelIds).toEqual([1])
    expect(screen.getByText('0 of 3 selected')).toBeInTheDocument()
  })

  it('restores selection when a disabled channel is enabled without changing explicit exclusions', async () => {
    const user = userEvent.setup()
    const view = render(<Harness />)
    await user.click(screen.getByRole('checkbox', { name: /alpha/ }))
    view.rerender(
      <Harness
        channels={channels.map((channel) => ({ ...channel, status: 1 }))}
      />
    )
    expect(screen.getByRole('checkbox', { name: /alpha/ })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /beta/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /gamma/ })).toBeChecked()
    expect(excludedChannelIds).toEqual([1])
    expect(screen.getByText('2 of 3 selected')).toBeInTheDocument()
  })
})
