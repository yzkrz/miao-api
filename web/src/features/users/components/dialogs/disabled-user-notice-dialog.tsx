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
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { HtmlContent } from '@/components/html-content'
import { SecureVerificationDialog } from '@/features/auth/secure-verification'
import { useAccountSecurity } from '@/features/security/hooks/use-account-security'
import { handleServerError } from '@/lib/handle-server-error'
import { useSystemConfigStore } from '@/stores/system-config-store'

import { sendUserEmail } from '../../api'
import {
  accountSuspendedEmail,
  emailDraftDigest,
  prepareEmailDraft,
} from '../../lib/user-email'

/** Asks whether to email a just-disabled user a suspension notice. */
export function DisabledUserNoticeDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  user: { id: number; username: string; email: string }
}) {
  const { t } = useTranslation()
  const security = useAccountSecurity()
  const siteName = useSystemConfigStore((state) => state.config.systemName)
  const notice = useMemo(
    () =>
      accountSuspendedEmail(t, {
        username: props.user.username,
        siteName,
        siteUrl: window.location.origin,
      }),
    [t, props.user.username, siteName]
  )
  const send = async () => {
    const draft = prepareEmailDraft(notice.subject, notice.html)
    const result = await security.run(async (signal) => {
      const digest = await emailDraftDigest(draft)
      const proof = await security.verify(
        {
          scope: 'admin.user.email',
          context: {
            user_id: props.user.id,
            email: props.user.email,
            digest,
          },
          title: t('Send email'),
          description: t('Confirm sending this email to {{email}}.', {
            email: props.user.email,
          }),
        },
        signal
      )
      await sendUserEmail(props.user.id, draft, proof, signal)
      return { notification_warning: false }
    })
    if (result) {
      toast.success(t('Email sent successfully'))
      props.onOpenChange(false)
    }
  }
  return (
    <>
      <ConfirmDialog
        open={props.open && !security.showVerification}
        onOpenChange={(open) => {
          if (!security.pending) props.onOpenChange(open)
        }}
        className='sm:max-w-xl'
        title={t('Notify the user by email?')}
        desc={t(
          '{{username}} has been disabled. Send a suspension notice to {{email}}?',
          { username: props.user.username, email: props.user.email }
        )}
        cancelBtnText={t("Don't send")}
        confirmText={t('Send notice')}
        isLoading={security.pending}
        handleConfirm={() => void send().catch(handleServerError)}
      >
        <div
          aria-label={t('Email preview')}
          className='max-h-[50vh] overflow-y-auto rounded-md border p-4'
        >
          <p className='text-muted-foreground mb-3 text-sm'>
            {t('Subject')}: {notice.subject}
          </p>
          <HtmlContent
            content={notice.html}
            className='[&_a]:text-primary text-sm [&_a]:underline [&_h2]:mb-3 [&_h2]:text-lg [&_h2]:font-semibold [&_hr]:my-4 [&_p]:my-2'
          />
        </div>
      </ConfirmDialog>
      <SecureVerificationDialog {...security.verificationDialogProps} />
    </>
  )
}
