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
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useFieldArray, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  sideDrawerFooterClassName,
  sideDrawerFormClassName,
} from '@/components/drawer-layout'
import { MultiSelect } from '@/components/multi-select'
import { Button } from '@/components/ui/button'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { SheetClose, SheetFooter } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import {
  SettingsFormGrid,
  SettingsSwitchContent,
  SettingsSwitchItem,
} from '@/features/system-settings/components/settings-form-layout'
import { useResetForm } from '@/features/system-settings/hooks/use-reset-form'
import { safeNumberFieldProps } from '@/features/system-settings/utils/numeric-field'
import { handleServerError } from '@/lib/handle-server-error'
import { requireServerSuccess } from '@/lib/server-error-message'

import {
  modelReplacementQueryKeys,
  updateModelReplacementSettings,
} from '../../api'
import {
  SETTING_LIMITS,
  createDetectedModel,
  createModelReplacementSettingsSchema,
} from '../../lib/settings-form'
import type { ModelCandidate, ModelReplacementSettings } from '../../types'
import { ActionListField } from './action-list-field'
import { DetectedModelCard } from './detected-model-card'
import { IntervalWindowsField } from './interval-windows-field'

type NumericSettingField = {
  name:
    | 'interval_minutes'
    | 'rounds'
    | 'concurrency'
    | 'timeout_seconds'
    | 'threshold'
  label: string
  description: string
  min: number
  max: number
  step?: number
}

const NUMERIC_FIELDS: NumericSettingField[] = [
  {
    name: 'interval_minutes',
    label: 'Default detection interval (minutes)',
    description:
      'Used when a run finishes outside every time window below. Waiting starts after every round of the previous run has finished.',
    min: 1,
    max: SETTING_LIMITS.intervalMinutesMax,
  },
  {
    name: 'rounds',
    label: 'Test rounds',
    description:
      'Each round tests every matching channel once; the next round starts after all channels finish.',
    min: 1,
    max: SETTING_LIMITS.roundsMax,
  },
  {
    name: 'concurrency',
    label: 'Maximum concurrency',
    description:
      'Channels tested at the same time. Requests to one channel are always sent one after another.',
    min: 1,
    max: SETTING_LIMITS.concurrencyMax,
  },
  {
    name: 'timeout_seconds',
    label: 'Request timeout (seconds)',
    description: 'A request that takes longer counts as failed and is retried.',
    min: 1,
    max: SETTING_LIMITS.timeoutSecondsMax,
  },
  {
    name: 'threshold',
    label: 'Mismatch threshold (%)',
    description:
      'A round is mismatched when the answer is wrong or the returned model name does not exactly match the test model. A model is treated as replaced when the percentage of mismatched rounds exceeds this value.',
    min: 0,
    max: 100,
    step: 0.1,
  },
]

type ModelReplacementSettingsFormProps = {
  settings: ModelReplacementSettings
  serverTimeZone: string
  candidates: ModelCandidate[]
  groups: string[]
  /** Called after the settings were saved. */
  onSaved: () => void
}

export function ModelReplacementSettingsForm(
  props: ModelReplacementSettingsFormProps
) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const schema = useMemo(() => createModelReplacementSettingsSchema(t), [t])
  const form = useForm<ModelReplacementSettings>({
    resolver: zodResolver(schema),
    defaultValues: props.settings,
  })
  useResetForm(form, props.settings)
  const modelFields = useFieldArray({
    control: form.control,
    name: 'models',
    keyName: 'fieldKey',
  })

  const saveMutation = useMutation({
    mutationFn: async (values: ModelReplacementSettings) =>
      requireServerSuccess(await updateModelReplacementSettings(values)),
    onSuccess: async () => {
      toast.success(t('Settings saved'))
      await queryClient.invalidateQueries({
        queryKey: modelReplacementQueryKeys.all,
      })
      props.onSaved()
    },
    onError: (error) => handleServerError(error),
  })
  const onSave = form.handleSubmit((values) => saveMutation.mutate(values))

  const channelsByModel = useMemo(
    () => new Map(props.candidates.map((item) => [item.model, item.channels])),
    [props.candidates]
  )
  const modelOptions = useMemo(
    () =>
      props.candidates.map((item) => ({
        value: item.model,
        label: item.model,
        hint: t('{{count}} channels', { count: item.channels.length }),
      })),
    [props.candidates, t]
  )
  const selectedModels = modelFields.fields.map((field) => field.model)

  const handleModelsChange = (next: string[]) => {
    const removed = selectedModels
      .map((model, index) => (next.includes(model) ? -1 : index))
      .filter((index) => index >= 0)
    if (removed.length > 0) modelFields.remove(removed)
    for (const model of next) {
      if (!selectedModels.includes(model)) {
        modelFields.append(createDetectedModel(model))
      }
    }
  }

  return (
    <Form {...form}>
      <form
        onSubmit={onSave}
        noValidate
        className='flex min-h-0 flex-1 flex-col'
      >
        <div className={sideDrawerFormClassName()}>
          <SettingsFormGrid>
            <FormField
              control={form.control}
              name='enabled'
              render={({ field }) => (
                <SettingsSwitchItem>
                  <SettingsSwitchContent>
                    <FormLabel>
                      {t('Enable model replacement detection')}
                    </FormLabel>
                    <FormDescription>
                      {t(
                        'Turns scheduled and manual detection on or off for the whole feature.'
                      )}
                    </FormDescription>
                  </SettingsSwitchContent>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </SettingsSwitchItem>
              )}
            />
            {NUMERIC_FIELDS.map((item) => (
              <FormField
                key={item.name}
                control={form.control}
                name={item.name}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t(item.label)}</FormLabel>
                    <FormControl>
                      <Input
                        type='number'
                        min={item.min}
                        max={item.max}
                        step={item.step ?? 1}
                        {...safeNumberFieldProps(field)}
                      />
                    </FormControl>
                    <FormDescription>{t(item.description)}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ))}
            <IntervalWindowsField
              control={form.control}
              serverTimeZone={props.serverTimeZone}
              defaultInterval={form.getValues('interval_minutes')}
            />
          </SettingsFormGrid>

          <Separator />

          <div className='flex min-w-0 flex-col gap-4'>
            <div className='space-y-1'>
              <h4 className='text-sm font-medium'>
                {t('Actions after detection')}
              </h4>
              <p className='text-muted-foreground text-xs'>
                {t(
                  'Each list runs top to bottom on every detected channel after each run. Only what an action names is changed; other groups, such as default or vip, are left as they are.'
                )}
              </p>
            </div>
            <div className='grid gap-3 lg:grid-cols-2'>
              <FormField
                control={form.control}
                name='pass_actions'
                render={({ field, fieldState }) => (
                  <ActionListField
                    title={t('When detection passes')}
                    description={t(
                      'Runs on a channel whose detected models all matched.'
                    )}
                    value={field.value}
                    onChange={field.onChange}
                    groups={props.groups}
                    error={fieldState.error?.message}
                  />
                )}
              />
              <FormField
                control={form.control}
                name='fail_actions'
                render={({ field, fieldState }) => (
                  <ActionListField
                    title={t('When replacement is suspected')}
                    description={t(
                      'Runs only when a model is suspected of being replaced and no request has failed after retries.'
                    )}
                    value={field.value}
                    onChange={field.onChange}
                    groups={props.groups}
                    error={fieldState.error?.message}
                  />
                )}
              />
              <FormField
                control={form.control}
                name='request_failure_actions'
                render={({ field, fieldState }) => (
                  <ActionListField
                    title={t('When requests fail')}
                    description={t(
                      'Runs when a request still fails after all retries. Only these actions run, even if another model is suspected of being replaced.'
                    )}
                    value={field.value}
                    onChange={field.onChange}
                    groups={props.groups}
                    error={fieldState.error?.message}
                  />
                )}
              />
            </div>
          </div>

          <Separator />

          <div className='flex min-w-0 flex-col gap-4'>
            <div className='space-y-1'>
              <h4 className='text-sm font-medium'>{t('Detected models')}</h4>
              <p className='text-muted-foreground text-xs'>
                {t(
                  'If any detected model of a channel is replaced, the whole channel is handled.'
                )}
              </p>
            </div>
            <MultiSelect
              options={modelOptions}
              selected={selectedModels}
              onChange={handleModelsChange}
              placeholder={t('Select models to detect')}
              emptyText={t('No available models')}
              maxVisibleChips={12}
            />
            {modelFields.fields.length === 0 ? (
              <p className='text-muted-foreground rounded-md border border-dashed px-4 py-6 text-center text-sm'>
                {t('No models selected yet.')}
              </p>
            ) : (
              <div className='flex flex-col gap-3'>
                {modelFields.fields.map((field, index) => (
                  <DetectedModelCard
                    key={field.fieldKey}
                    index={index}
                    model={field.model}
                    channels={channelsByModel.get(field.model) ?? []}
                    control={form.control}
                    onRemove={() => modelFields.remove(index)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
        <SheetFooter className={sideDrawerFooterClassName()}>
          <SheetClose
            render={<Button variant='outline' className='w-full sm:w-auto' />}
          >
            {t('Cancel')}
          </SheetClose>
          <Button
            type='submit'
            className='w-full sm:w-auto'
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending ? t('Saving...') : t('Save changes')}
          </Button>
        </SheetFooter>
      </form>
    </Form>
  )
}
