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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  SideDrawerSection,
  SideDrawerSectionHeader,
  sideDrawerContentClassName,
  sideDrawerFooterClassName,
  sideDrawerFormClassName,
  sideDrawerHeaderClassName,
} from '@/components/drawer-layout'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
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
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { safeNumberFieldProps } from '@/features/system-settings/utils/numeric-field'
import { quotaUnitsToDollars, quotaUnitsToEditableAmount } from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'
import {
  formatUsageWindow,
  formatUsageRuleWindow,
  type UsageRuleStatus,
} from '@/lib/usage-limits'
import { useSystemConfigStore } from '@/stores/system-config-store'

import {
  getUserLimits,
  getUserLimitModels,
  resetUserLimitWindows,
  updateUserLimits,
} from '../../api'
import {
  MAX_USER_CONCURRENCY,
  createUserLimitsFormSchema,
  userLimitsFormToPayload,
  userLimitsToFormValues,
  type UserLimitsFormValues,
} from '../../lib/user-limits-form'
import { UsageRulesField } from './usage-rules-field'

interface UserLimitsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  user: { id: number; username?: string }
  onSuccess?: () => void
}

/**
 * Administrator panel for one user's usage limit rules and concurrency cap.
 */
export function UserLimitsDialog(props: UserLimitsDialogProps) {
  const { t } = useTranslation()
  useSystemConfigStore((state) => state.config.currency)
  const displayScale = quotaUnitsToDollars(1)
  const previousScale = useRef(displayScale)
  const queryClient = useQueryClient()
  const userId = props.user.id
  const queryKey = useMemo(() => ['user-limits', userId], [userId])
  // Observes the cache only: the form is filled from the fetch made on open,
  // and later cache updates (an ended window) refresh the window display
  // without discarding unsaved edits.
  const { data: limits } = useQuery({
    queryKey,
    queryFn: () => getUserLimits(userId),
    enabled: false,
  })
  const modelsQuery = useQuery({
    queryKey: ['user-limit-models', userId],
    queryFn: () => getUserLimitModels(userId),
    enabled: props.open,
  })
  const schema = useMemo(() => createUserLimitsFormSchema(t), [t])
  const form = useForm<UserLimitsFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { max_concurrency: 0, usage_rules: [] },
  })
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>(
    'loading'
  )
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [pendingReset, setPendingReset] = useState<number | null>(null)

  // Keep the quota represented by unsaved inputs when display currency changes.
  useEffect(() => {
    const oldScale = previousScale.current
    previousScale.current = displayScale
    if (oldScale === displayScale || loadState !== 'ready') return
    for (const [index, rule] of form.getValues('usage_rules').entries()) {
      const units = Math.round(rule.quota_amount / oldScale)
      form.setValue(
        `usage_rules.${index}.quota_amount`,
        quotaUnitsToEditableAmount(units),
        { shouldValidate: true }
      )
    }
  }, [displayScale, form, loadState])

  useEffect(() => {
    if (!props.open) return
    let cancelled = false
    queryClient
      .fetchQuery({
        queryKey,
        queryFn: () => getUserLimits(userId),
        staleTime: 0,
      })
      .then((loaded) => {
        if (cancelled) return
        form.reset(userLimitsToFormValues(loaded))
        setLoadState('ready')
      })
      .catch(() => {
        // The query cache already reports the failure.
        if (!cancelled) setLoadState('error')
      })
    return () => {
      cancelled = true
    }
  }, [props.open, loadAttempt, queryClient, queryKey, userId, form])

  const handleOpenChange = (open: boolean) => {
    if (!open) setLoadState('loading')
    props.onOpenChange(open)
  }

  const savedRules = useMemo(() => {
    const rules = new Map<number, UsageRuleStatus>()
    for (const rule of limits?.usage_rules ?? []) {
      rules.set(rule.window_seconds, rule)
    }
    return rules
  }, [limits])

  const saveMutation = useMutation({
    mutationFn: (values: UserLimitsFormValues) =>
      updateUserLimits(userId, userLimitsFormToPayload(values)),
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKey, saved)
      toast.success(t('Usage limits saved'))
      props.onSuccess?.()
      handleOpenChange(false)
    },
    onError: (error) => handleServerError(error, t('Operation failed')),
  })

  const resetMutation = useMutation({
    mutationFn: (windowSeconds: number) =>
      resetUserLimitWindows(userId, windowSeconds),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKey, updated)
      toast.success(t('Usage window ended'))
    },
    onError: (error) => handleServerError(error, t('Operation failed')),
    onSettled: () => setPendingReset(null),
  })

  const formReady = loadState === 'ready'
  const resetRule = savedRules.get(pendingReset ?? 0)

  return (
    <>
      <Sheet open={props.open} onOpenChange={handleOpenChange}>
        <SheetContent className={sideDrawerContentClassName('sm:max-w-2xl')}>
          <SheetHeader className={sideDrawerHeaderClassName()}>
            <SheetTitle>{t('Usage Limits')}</SheetTitle>
            <SheetDescription>
              {props.user.username || '-'} (ID: {userId})
            </SheetDescription>
          </SheetHeader>
          {loadState === 'error' && (
            <div className={sideDrawerFormClassName()}>
              <ErrorState
                title={t('Loading failed')}
                onRetry={() => {
                  setLoadState('loading')
                  setLoadAttempt((attempt) => attempt + 1)
                }}
              />
            </div>
          )}
          {loadState === 'loading' && (
            <div className={sideDrawerFormClassName()}>
              <LoadingState message={t('Loading...')} />
            </div>
          )}
          {formReady && (
            <Form {...form}>
              <form
                id='user-limits-form'
                onSubmit={form.handleSubmit((values) =>
                  saveMutation.mutate(values)
                )}
                className={sideDrawerFormClassName()}
              >
                <SideDrawerSection>
                  <SideDrawerSectionHeader
                    title={t('Concurrency')}
                    description={t(
                      'Relay requests this user can have in flight at once, across all tokens. 0 means unlimited.'
                    )}
                  />
                  <FormField
                    control={form.control}
                    name='max_concurrency'
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('Maximum concurrency')}</FormLabel>
                        <FormControl>
                          <Input
                            type='number'
                            min={0}
                            max={MAX_USER_CONCURRENCY}
                            step={1}
                            {...safeNumberFieldProps(field)}
                          />
                        </FormControl>
                        <FormDescription>
                          {t('In flight now: {{count}}', {
                            count: limits?.current_concurrency ?? 0,
                          })}
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </SideDrawerSection>
                <SideDrawerSection>
                  <UsageRulesField
                    control={form.control}
                    candidates={modelsQuery.data ?? []}
                    modelsLoading={modelsQuery.isPending || modelsQuery.isError}
                    serverTimeZone={limits?.server_time_zone}
                    savedRules={savedRules}
                    resetting={resetMutation.isPending}
                    onResetWindow={setPendingReset}
                  />
                  {modelsQuery.isError && (
                    <ErrorState
                      title={t('Failed to load models')}
                      onRetry={() => void modelsQuery.refetch()}
                    />
                  )}
                </SideDrawerSection>
              </form>
            </Form>
          )}
          <SheetFooter className={sideDrawerFooterClassName()}>
            <SheetClose render={<Button variant='outline' />}>
              {t('Close')}
            </SheetClose>
            <Button
              form='user-limits-form'
              type='submit'
              disabled={!formReady || saveMutation.isPending}
            >
              {saveMutation.isPending ? t('Saving...') : t('Save changes')}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={pendingReset !== null}
        onOpenChange={(open) => !open && setPendingReset(null)}
        title={
          resetRule?.mode === 'calendar'
            ? t('Reset usage window')
            : t('End current window')
        }
        desc={t(
          resetRule?.mode === 'calendar'
            ? 'Clear usage for {{window}} of {{username}}? The calendar reset time stays unchanged.'
            : 'End the current {{window}} window of {{username}}? Its usage is cleared, and the next charged request starts a new window.',
          {
            window: resetRule
              ? formatUsageRuleWindow(resetRule, t)
              : formatUsageWindow(pendingReset ?? 0, t),
            username: props.user.username || `#${userId}`,
          }
        )}
        confirmText={
          resetRule?.mode === 'calendar' ? t('Reset') : t('End window')
        }
        isLoading={resetMutation.isPending}
        handleConfirm={() => {
          if (pendingReset !== null) resetMutation.mutate(pendingReset)
        }}
      />
    </>
  )
}
