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
import { CalendarClock, HeartPulse, History, Play } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { RingProgress } from '@/components/ring-progress'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { toIntlLocale } from '@/i18n/languages'
import { formatTimestampRelative, formatTimestampToDate } from '@/lib/format'

import { formatTimeRange } from '../../lib/report'
import type { DetectionOverview } from '../../types'

type OverviewCardsProps = {
  overview: DetectionOverview
  /** Currently enabled channels whose latest detection passed. */
  healthyCount: number
  /** Union of channels serving configured models, excluding explicit exclusions. */
  totalCount: number
  isStarting: boolean
  onRunNow: () => void
}

export function OverviewCards(props: OverviewCardsProps) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const lastRun = props.overview.last_run
  const activeRun = props.overview.active_run
  const lastSummary = lastRun?.result
  const progress = activeRun?.state?.progress ?? 0
  const healthyPercent =
    props.totalCount > 0 ? (props.healthyCount / props.totalCount) * 100 : null
  const healthyPercentText =
    healthyPercent === null ? '-' : `${Math.round(healthyPercent)}%`

  let nextRunText = t('Detection is off')
  if (activeRun) {
    nextRunText =
      activeRun.status === 'pending' ? t('Queued') : t('Running now')
  } else if (props.overview.next_run_at) {
    nextRunText = formatTimestampToDate(props.overview.next_run_at)
  }

  let runDisabledReason = ''
  if (!props.overview.enabled) {
    runDisabledReason = t(
      'Turn on detection in Detection settings at the top right first.'
    )
  } else if (activeRun) {
    runDisabledReason = t('A detection run is already in progress.')
  }

  return (
    <div className='flex flex-col gap-3 lg:flex-row lg:items-stretch'>
      <div className='grid min-w-0 flex-1 gap-3 sm:grid-cols-2 xl:grid-cols-3'>
        <Card size='sm'>
          <CardHeader>
            <CardDescription className='flex items-center gap-1.5'>
              <HeartPulse className='size-3.5' aria-hidden='true' />
              {t('Channel health')}
            </CardDescription>
          </CardHeader>
          <CardContent className='flex items-center gap-4'>
            <RingProgress
              percent={healthyPercent}
              size={72}
              strokeWidth={8}
              className='text-success'
              trackClassName='text-success/15'
            >
              <span className='text-base font-semibold tabular-nums'>
                {healthyPercentText}
              </span>
            </RingProgress>
            <div className='text-muted-foreground min-w-0 space-y-0.5 text-xs'>
              <p className='text-foreground text-sm font-medium'>
                {t('Healthy share')}
              </p>
              {props.totalCount > 0 ? (
                <>
                  <p className='tabular-nums'>
                    {t('{{count}} healthy and enabled', {
                      count: props.healthyCount,
                    })}
                  </p>
                  <p className='tabular-nums'>
                    {t('{{count}} channels in detection scope', {
                      count: props.totalCount,
                    })}
                  </p>
                </>
              ) : (
                <p>{t('No channels are in detection scope yet.')}</p>
              )}
            </div>
          </CardContent>
        </Card>
        <Card size='sm'>
          <CardHeader>
            <CardDescription className='flex items-center gap-1.5'>
              <History className='size-3.5' aria-hidden='true' />
              {t('Last test period')}
            </CardDescription>
            <CardTitle className='text-base tabular-nums'>
              {lastSummary
                ? formatTimeRange(
                    lastSummary.started_at,
                    lastSummary.finished_at
                  )
                : '-'}
            </CardTitle>
          </CardHeader>
          <CardContent className='text-muted-foreground text-xs'>
            {lastRun?.status === 'failed' && (
              <p className='text-destructive'>
                {t('Last run failed: {{error}}', { error: lastRun.error })}
              </p>
            )}
            {lastRun?.status !== 'failed' && lastSummary && (
              <p>
                {t(
                  '{{channels}} channels · {{passed}} passed · {{replaced}} suspected · {{failed}} failed',
                  {
                    channels: lastSummary.channels,
                    passed: lastSummary.passed,
                    replaced: lastSummary.replaced,
                    failed: lastSummary.failed,
                  }
                )}
              </p>
            )}
            {!lastRun && <p>{t('No detection has run yet.')}</p>}
          </CardContent>
        </Card>
        <Card size='sm'>
          <CardHeader>
            <CardDescription className='flex items-center gap-1.5'>
              <CalendarClock className='size-3.5' aria-hidden='true' />
              {t('Next test time')}
            </CardDescription>
            <CardTitle className='text-base tabular-nums'>
              {nextRunText}
            </CardTitle>
          </CardHeader>
          <CardContent className='text-muted-foreground text-xs'>
            {activeRun ? (
              <div className='space-y-1.5'>
                <Progress
                  value={progress}
                  aria-label={t('Detection progress')}
                />
                <p className='tabular-nums'>
                  {t('{{processed}} / {{total}} channel rounds', {
                    processed: activeRun.state?.processed ?? 0,
                    total: activeRun.state?.total ?? 0,
                  })}
                </p>
              </div>
            ) : (
              <p>
                {props.overview.enabled && props.overview.next_run_at
                  ? t('{{relative}} · every {{minutes}} minutes', {
                      relative: formatTimestampRelative(
                        props.overview.next_run_at,
                        'seconds',
                        locale
                      ),
                      minutes: props.overview.next_interval_minutes,
                    })
                  : t('Scheduled detection is not running.')}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
      <div className='flex flex-col items-stretch justify-center gap-1.5 lg:w-48'>
        <Button
          type='button'
          onClick={props.onRunNow}
          disabled={props.isStarting || runDisabledReason !== ''}
          aria-describedby={
            runDisabledReason ? 'model-replacement-run-hint' : undefined
          }
        >
          <Play data-icon='inline-start' aria-hidden='true' />
          {props.isStarting ? t('Starting...') : t('Test now')}
        </Button>
        {runDisabledReason && (
          <p
            id='model-replacement-run-hint'
            className='text-muted-foreground text-center text-xs'
          >
            {runDisabledReason}
          </p>
        )}
      </div>
    </div>
  )
}
