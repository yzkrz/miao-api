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
import { Trash2 } from 'lucide-react'
import type { Control } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { CHANNEL_STATUS } from '@/features/channels/constants'
import { safeNumberFieldProps } from '@/features/system-settings/utils/numeric-field'
import { cn } from '@/lib/utils'

import { SETTING_LIMITS, setChannelIncluded } from '../../lib/settings-form'
import type { DetectionChannel, ModelReplacementSettings } from '../../types'
import { ChannelStatusBadge } from '../report/badges'

const MATCH_MODE_LABELS = {
  exact: 'Exact match',
  contains: 'Contains',
  regex: 'Regular expression',
} as const

type DetectedModelCardProps = {
  index: number
  model: string
  channels: DetectionChannel[]
  control: Control<ModelReplacementSettings>
  onRemove: () => void
}

export function DetectedModelCard(props: DetectedModelCardProps) {
  const { t } = useTranslation()
  const matchModeItems = Object.entries(MATCH_MODE_LABELS).map(
    ([value, label]) => ({ value, label: t(label) })
  )

  return (
    <section
      aria-label={props.model}
      className='bg-card flex min-w-0 flex-col gap-4 rounded-lg border p-4'
    >
      <div className='flex items-center justify-between gap-2'>
        <h5 className='min-w-0 truncate font-mono text-sm font-medium'>
          {props.model}
        </h5>
        <Button
          type='button'
          variant='ghost'
          size='icon-sm'
          aria-label={t('Stop detecting {{model}}', { model: props.model })}
          onClick={props.onRemove}
        >
          <Trash2 aria-hidden='true' />
        </Button>
      </div>

      <div className='grid gap-4 lg:grid-cols-2'>
        <FormField
          control={props.control}
          name={`models.${props.index}.question`}
          render={({ field }) => (
            <FormItem className='lg:col-span-2'>
              <FormLabel>{t('Test question')}</FormLabel>
              <FormControl>
                <Textarea
                  rows={3}
                  maxLength={SETTING_LIMITS.textMax}
                  placeholder={t(
                    'e.g. Which model are you? Reply with the model name only.'
                  )}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={props.control}
          name={`models.${props.index}.expected_answer`}
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('Expected answer')}</FormLabel>
              <FormControl>
                <Input maxLength={SETTING_LIMITS.textMax} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={props.control}
          name={`models.${props.index}.match_mode`}
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('Answer match mode')}</FormLabel>
              <Select
                items={matchModeItems}
                value={field.value}
                onValueChange={field.onChange}
              >
                <FormControl>
                  <SelectTrigger className='w-full'>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>
                    {matchModeItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FormDescription>
                {t(
                  'Leading and trailing whitespace in replies is ignored. Exact and contains matching are case-sensitive.'
                )}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={props.control}
          name={`models.${props.index}.retry_times`}
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('Retry times')}</FormLabel>
              <FormControl>
                <Input
                  type='number'
                  min={0}
                  max={SETTING_LIMITS.retryTimesMax}
                  step={1}
                  {...safeNumberFieldProps(field)}
                />
              </FormControl>
              <FormDescription>
                {t(
                  'A failed or timed-out request is retried immediately. When retries run out, the channel counts as failed and the failure actions run.'
                )}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      <FormField
        control={props.control}
        name={`models.${props.index}.excluded_channel_ids`}
        render={({ field }) => {
          const excluded = field.value ?? []
          const includedCount = props.channels.filter(
            (channel) =>
              channel.status === CHANNEL_STATUS.ENABLED &&
              !excluded.includes(channel.id)
          ).length
          return (
            <FormItem>
              <div className='flex items-center justify-between gap-2'>
                <FormLabel>{t('Channels')}</FormLabel>
                <span className='text-muted-foreground text-xs tabular-nums'>
                  {t('{{selected}} of {{total}} selected', {
                    selected: includedCount,
                    total: props.channels.length,
                  })}
                </span>
              </div>
              {props.channels.length === 0 ? (
                <p className='text-muted-foreground rounded-md border border-dashed px-3 py-4 text-center text-sm'>
                  {t('No channel currently provides this model.')}
                </p>
              ) : (
                <ul className='grid max-h-64 gap-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-2'>
                  {props.channels.map((channel) => {
                    const disabled = channel.status !== CHANNEL_STATUS.ENABLED
                    const checkboxId = `model-${props.index}-channel-${channel.id}`
                    return (
                      <li
                        key={channel.id}
                        className={cn(
                          'flex min-w-0 items-center gap-2 rounded px-1.5 py-1',
                          disabled && 'opacity-60'
                        )}
                      >
                        <Checkbox
                          id={checkboxId}
                          checked={!disabled && !excluded.includes(channel.id)}
                          disabled={disabled}
                          onCheckedChange={(checked) =>
                            field.onChange(
                              setChannelIncluded(
                                excluded,
                                channel.id,
                                checked === true
                              )
                            )
                          }
                        />
                        <label
                          htmlFor={checkboxId}
                          className={cn(
                            'min-w-0 flex-1 truncate text-sm',
                            disabled ? 'cursor-not-allowed' : 'cursor-pointer'
                          )}
                        >
                          <span className='text-muted-foreground tabular-nums'>
                            #{channel.id}
                          </span>{' '}
                          {channel.name}
                        </label>
                        {disabled && (
                          <ChannelStatusBadge status={channel.status} />
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
              <FormDescription>
                {t(
                  'Disabled channels are skipped and are detected again after the automatic re-enable rules restore them. New channels are included by default.'
                )}
              </FormDescription>
            </FormItem>
          )
        }}
      />
    </section>
  )
}
