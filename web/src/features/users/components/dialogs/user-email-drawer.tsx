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
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  sideDrawerContentClassName,
  sideDrawerHeaderClassName,
  sideDrawerFormClassName,
  sideDrawerFooterClassName,
} from '@/components/drawer-layout'
import { HtmlContent } from '@/components/html-content'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { SecureVerificationDialog } from '@/features/auth/secure-verification'
import { useAccountSecurity } from '@/features/security/hooks/use-account-security'
import { handleServerError } from '@/lib/handle-server-error'

import { sendUserEmail } from '../../api'
import { prepareEmailDraft, emailDraftDigest } from '../../lib/user-email'
import { EmailEditor } from './user-email-editor'

export function UserEmailDrawer(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  user: { id: number; username: string; email?: string }
}) {
  const { t } = useTranslation()
  const security = useAccountSecurity()
  const editor = useRef<HTMLDivElement>(null)
  const [subject, setSubject] = useState('')
  const [html, setHtml] = useState('')
  const [preview, setPreview] = useState(false)
  const send = async () => {
    const draft = prepareEmailDraft(subject, editor.current?.innerHTML ?? html)
    if (!draft.subject || !draft.html.trim()) return
    const result = await security.run(async (signal) => {
      const digest = await emailDraftDigest(draft)
      const proof = await security.verify(
        {
          scope: 'admin.user.email',
          context: {
            user_id: props.user.id,
            email: props.user.email ?? '',
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
      <Sheet
        open={props.open && !security.showVerification}
        onOpenChange={(open) => {
          if (!security.pending) props.onOpenChange(open)
        }}
      >
        <SheetContent
          className={sideDrawerContentClassName('sm:max-w-3xl')}
          showCloseButton={!security.pending}
        >
          <SheetHeader className={sideDrawerHeaderClassName()}>
            <SheetTitle>{t('Send email')}</SheetTitle>
            <SheetDescription>{props.user.username}</SheetDescription>
          </SheetHeader>
          <form
            id='user-email-form'
            className={sideDrawerFormClassName()}
            onSubmit={(event) => {
              event.preventDefault()
              void send().catch(handleServerError)
            }}
          >
            <div className='space-y-2'>
              <Label htmlFor='email-recipient'>{t('Recipient')}</Label>
              <Input
                id='email-recipient'
                value={props.user.email ?? ''}
                readOnly
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='email-subject'>{t('Subject')}</Label>
              <Input
                id='email-subject'
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                maxLength={200}
                required
                disabled={security.pending}
              />
            </div>
            <EmailEditor
              editorRef={editor}
              html={html}
              onChange={setHtml}
              disabled={security.pending}
            />
            <Button
              type='button'
              variant='outline'
              onClick={() => setPreview(!preview)}
            >
              {t('Preview')}
            </Button>
            {preview && (
              <HtmlContent
                content={html}
                className='[&_a]:text-primary rounded-md border p-4 [&_a]:underline [&_h2]:text-xl [&_h2]:font-semibold [&_img]:max-w-full [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-6'
              />
            )}
          </form>
          <div className={sideDrawerFooterClassName()}>
            <Button
              variant='outline'
              disabled={security.pending}
              onClick={() => props.onOpenChange(false)}
            >
              {t('Cancel')}
            </Button>
            <Button
              form='user-email-form'
              type='submit'
              disabled={security.pending || !subject.trim() || !html.trim()}
            >
              {t('Send email')}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
      <SecureVerificationDialog {...security.verificationDialogProps} />
    </>
  )
}
