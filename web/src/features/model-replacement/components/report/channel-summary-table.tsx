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
import { LineChart, RefreshCw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  StaticDataTable,
  type StaticDataTableColumn,
} from '@/components/data-table'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { CHANNEL_STATUS } from '@/features/channels/constants'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber, formatPercent } from '@/lib/format'

import { describeAction } from '../../lib/actions'
import {
  DEFAULT_CHANNEL_SUMMARY_FILTER,
  filterChannelSummary,
  formatTimeRange,
  getRecordMatchPercent,
  getRecordVerdict,
  type ChannelStatusFilter,
} from '../../lib/report'
import type { DetectionChannelRow } from '../../types'
import { ChannelStatusBadge, VerdictBadge } from './badges'
import { ChannelSummaryFilters } from './channel-filters'
import { ChannelStatusTabs } from './channel-status-tabs'
import { ModelRatesPopover } from './model-rates-popover'

type ChannelSummaryTableProps = {
  rows: DetectionChannelRow[]
  model: string | null
  onViewReport: (channelId: number) => void
  onRetest?: (channelId: number) => void
  isDetecting?: boolean
}

export function ChannelSummaryTable(props: ChannelSummaryTableProps) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const [filter, setFilter] = useState(DEFAULT_CHANNEL_SUMMARY_FILTER)
  const lists = useMemo(() => {
    const all = filterChannelSummary(
      props.rows,
      { ...filter, status: 'all' },
      props.model
    )
    const grouped: Record<ChannelStatusFilter, DetectionChannelRow[]> = {
      all,
      healthy: [],
      abnormal: [],
      failed: [],
      unrequested: [],
    }
    for (const row of all) {
      const verdict = row.latest
        ? getRecordVerdict(row.latest, props.model)
        : null
      if (verdict === 'passed') grouped.healthy.push(row)
      else if (verdict === 'replaced') grouped.abnormal.push(row)
      else if (verdict === 'failed') grouped.failed.push(row)
      else grouped.unrequested.push(row)
    }
    return grouped
  }, [props.rows, filter, props.model])

  const columns: StaticDataTableColumn<DetectionChannelRow>[] = [
    {
      id: 'channel',
      header: t('Channel'),
      className: 'min-w-48',
      cell: (row) => (
        <div className='flex min-w-0 flex-col gap-1'>
          <span className='truncate font-medium'>
            <span className='text-muted-foreground tabular-nums'>
              #{row.id}
            </span>{' '}
            {row.name}
          </span>
          <span>
            <ChannelStatusBadge status={row.status} />
          </span>
        </div>
      ),
    },
    {
      id: 'groups',
      header: t('Groups'),
      className: 'min-w-32 max-w-64 whitespace-normal break-words',
      cell: (row) => row.groups.join(', ') || '-',
    },
    {
      id: 'period',
      header: t('Last test period'),
      className: 'min-w-56',
      cell: (row) =>
        row.latest
          ? formatTimeRange(row.latest.started_at, row.latest.finished_at)
          : t('Not tested yet'),
    },
    {
      id: 'percent',
      header: t('Match rate'),
      cell: (row) => {
        const percent = row.latest
          ? getRecordMatchPercent(row.latest, props.model)
          : null
        return <span className='tabular-nums'>{formatPercent(percent)}</span>
      },
    },
    {
      id: 'verdict',
      header: t('Result'),
      cell: (row) => (
        <VerdictBadge
          verdict={
            row.latest ? getRecordVerdict(row.latest, props.model) : null
          }
        />
      ),
    },
    {
      id: 'latency',
      header: t('Avg response time'),
      cell: (row) =>
        row.latest?.avg_latency_ms
          ? `${formatNumber(row.latest.avg_latency_ms, locale)} ms`
          : '-',
    },
    {
      id: 'handling',
      header: t('Handling'),
      className: 'min-w-48',
      cell: (row) => {
        if (!row.latest) return '-'
        const changed = row.latest.actions.filter((action) => action.changed)
        let handling = '-'
        if (changed.length > 0) {
          handling = changed
            .map((action) => describeAction(action, t))
            .join('; ')
        } else if (row.latest.actions.length > 0) {
          handling = t('No changes')
        }
        return (
          <div className='flex min-w-0 flex-col gap-0.5 text-xs'>
            <span className='line-clamp-2 break-words'>{handling}</span>
            {row.latest.error_message && (
              <span className='text-destructive truncate'>
                {row.latest.error_message}
              </span>
            )}
            {!row.in_scope && (
              <span className='text-muted-foreground'>
                {t('No longer in detection scope')}
              </span>
            )}
          </div>
        )
      },
    },
    {
      id: 'actions',
      header: <span className='sr-only'>{t('Actions')}</span>,
      className: 'w-44 text-right',
      cellClassName: 'text-right',
      cell: (row) => (
        <div className='flex justify-end gap-1'>
          <ModelRatesPopover row={row} />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type='button'
                  variant='ghost'
                  size='icon-sm'
                  disabled={
                    props.isDetecting ||
                    !row.in_scope ||
                    row.status !== CHANNEL_STATUS.ENABLED
                  }
                  onClick={() => props.onRetest?.(row.id)}
                  aria-label={t('Retest channel {{name}}', { name: row.name })}
                />
              }
            >
              <RefreshCw aria-hidden='true' />
            </TooltipTrigger>
            <TooltipContent>{t('Retest')}</TooltipContent>
          </Tooltip>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            disabled={!row.latest}
            onClick={() => props.onViewReport(row.id)}
            aria-label={t('View the detection chart for channel {{name}}', {
              name: row.name,
            })}
          >
            <LineChart data-icon='inline-start' aria-hidden='true' />
            {t('Details')}
          </Button>
        </div>
      ),
    },
  ]

  return (
    <Tabs
      value={filter.status}
      onValueChange={(status) =>
        setFilter({ ...filter, status: status as ChannelStatusFilter })
      }
      className='min-w-0 gap-3'
    >
      <ChannelSummaryFilters value={filter} onChange={setFilter} />
      <ChannelStatusTabs
        counts={{
          all: lists.all.length,
          healthy: lists.healthy.length,
          abnormal: lists.abnormal.length,
          failed: lists.failed.length,
          unrequested: lists.unrequested.length,
        }}
      />
      <TabsContent value={filter.status}>
        <StaticDataTable
          columns={columns}
          data={lists[filter.status]}
          getRowKey={(row) => row.id}
          tableClassName='min-w-[900px]'
          emptyContent={
            props.rows.length > 0
              ? t('No matching channels')
              : t('No channels are in detection scope yet.')
          }
        />
      </TabsContent>
    </Tabs>
  )
}
