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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LineChart, ListChecks, Settings2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ErrorState } from '@/components/error-state'
import { SectionPageLayout } from '@/components/layout'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { TitledCard } from '@/components/ui/titled-card'
import { handleServerError } from '@/lib/handle-server-error'
import { requireServerSuccess } from '@/lib/server-error-message'

import {
  getModelReplacementChannels,
  getModelReplacementOverview,
  modelReplacementQueryKeys,
  runModelReplacementDetection,
} from './api'
import { ChannelReportPanel } from './components/report/channel-report-panel'
import { ChannelSummaryTable } from './components/report/channel-summary-table'
import { OverviewCards } from './components/report/overview-cards'
import { ModelReplacementSettingsDrawer } from './components/settings/model-replacement-settings-drawer'
import { countChannelHealth } from './lib/report'

const ACTIVE_POLL_INTERVAL_MS = 5000
const IDLE_POLL_INTERVAL_MS = 30000
const ALL_MODELS = '__all__'

export function ModelReplacement() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [model, setModel] = useState<string | null>(null)
  const [channelId, setChannelId] = useState<number | null>(null)
  const [recordId, setRecordId] = useState<number | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const reportRef = useRef<HTMLDivElement>(null)

  const overviewQuery = useQuery({
    queryKey: modelReplacementQueryKeys.overview(),
    queryFn: async () =>
      requireServerSuccess(await getModelReplacementOverview()).data ?? null,
    refetchInterval: (query) =>
      query.state.data?.active_run
        ? ACTIVE_POLL_INTERVAL_MS
        : IDLE_POLL_INTERVAL_MS,
  })
  const channelsQuery = useQuery({
    queryKey: modelReplacementQueryKeys.channels(),
    queryFn: async () =>
      requireServerSuccess(await getModelReplacementChannels()).data ?? [],
    refetchInterval: IDLE_POLL_INTERVAL_MS,
  })

  // Reload the report once a run finishes so the new results show up.
  const activeRunId = overviewQuery.data?.active_run?.task_id ?? null
  const previousActiveRunId = useRef<string | null>(null)
  useEffect(() => {
    if (previousActiveRunId.current && !activeRunId) {
      void queryClient.invalidateQueries({
        queryKey: modelReplacementQueryKeys.channels(),
      })
      void queryClient.invalidateQueries({
        queryKey: [...modelReplacementQueryKeys.all, 'history'],
      })
    }
    previousActiveRunId.current = activeRunId
  }, [activeRunId, queryClient])

  const runMutation = useMutation({
    mutationFn: async () =>
      requireServerSuccess(await runModelReplacementDetection()),
    onSuccess: () => {
      toast.success(t('Detection started'))
    },
    onError: (error) => handleServerError(error),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: modelReplacementQueryKeys.overview(),
      }),
  })

  const rows = useMemo(() => channelsQuery.data ?? [], [channelsQuery.data])
  const detectedRows = useMemo(
    () => rows.filter((row) => row.in_scope || row.latest),
    [rows]
  )
  const models = overviewQuery.data?.models ?? []
  const modelItems = [
    { value: ALL_MODELS, label: t('All models (worst)') },
    ...models.map((name) => ({ value: name, label: name })),
  ]
  // Visibility filters do not change the union of channels in detection scope.
  const healthCounts = useMemo(() => countChannelHealth(rows), [rows])
  // A chart channel that has since been deleted falls back to all channels.
  const chartChannelId = detectedRows.some((row) => row.id === channelId)
    ? channelId
    : null

  const handleViewReport = (id: number) => {
    setChannelId(id)
    setRecordId(null)
    reportRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  let content = <LoadingState className='min-h-64' />
  if (overviewQuery.isError && !overviewQuery.data) {
    content = (
      <ErrorState
        title={t('We could not load model replacement detection.')}
        onRetry={() => void overviewQuery.refetch()}
      />
    )
  } else if (overviewQuery.data) {
    const overview = overviewQuery.data
    content = (
      <div className='flex flex-col gap-4'>
        <OverviewCards
          overview={overview}
          healthyCount={healthCounts.healthy}
          totalCount={healthCounts.total}
          isStarting={runMutation.isPending}
          onRunNow={() => runMutation.mutate()}
        />

        <TitledCard
          title={t('Channel summary')}
          description={t(
            'Latest detection result of every channel in scope. Percentages follow the selected model, or the worst model when none is selected.'
          )}
          icon={<ListChecks aria-hidden='true' />}
          disableHoverEffect
          action={
            <Select
              items={modelItems}
              value={model ?? ALL_MODELS}
              onValueChange={(value) =>
                setModel(!value || value === ALL_MODELS ? null : value)
              }
            >
              <SelectTrigger
                className='w-full sm:w-56'
                aria-label={t('Filter by model')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {modelItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          }
        >
          {channelsQuery.isError ? (
            <ErrorState
              title={t('We could not load the channel results.')}
              onRetry={() => void channelsQuery.refetch()}
            />
          ) : (
            <ChannelSummaryTable
              rows={detectedRows}
              model={model}
              onViewReport={handleViewReport}
            />
          )}
        </TitledCard>

        <div ref={reportRef} className='scroll-mt-4'>
          <TitledCard
            title={t('Channel detection report')}
            description={t(
              'Health of each detection run, filtered by channel, model, and date. With no channel selected, every channel is drawn as its own line; with a model selected, only the channels serving it are drawn.'
            )}
            icon={<LineChart aria-hidden='true' />}
            disableHoverEffect
          >
            <ChannelReportPanel
              channels={detectedRows}
              models={models}
              channelId={chartChannelId}
              onChannelChange={setChannelId}
              recordId={recordId}
              onRecordChange={setRecordId}
            />
          </TitledCard>
        </div>
      </div>
    )
  }

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>
        <span className='inline-flex min-w-0 items-center gap-2'>
          <span className='truncate'>{t('Model replacement detection')}</span>
          {overviewQuery.data && (
            <Badge variant='outline' className='shrink-0'>
              {overviewQuery.data.enabled ? t('On') : t('Off')}
            </Badge>
          )}
        </span>
      </SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <Button
          type='button'
          variant='outline'
          size='sm'
          onClick={() => setSettingsOpen(true)}
        >
          <Settings2 data-icon='inline-start' aria-hidden='true' />
          {t('Detection settings')}
        </Button>
        {/* The layout renders only its slots; the drawer portals out. */}
        <ModelReplacementSettingsDrawer
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
        />
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>{content}</SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
