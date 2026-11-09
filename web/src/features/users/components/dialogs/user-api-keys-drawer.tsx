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
import { useTranslation } from 'react-i18next'

import {
  sideDrawerContentClassName,
  sideDrawerHeaderClassName,
} from '@/components/drawer-layout'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { ApiKeysDialogs } from '@/features/keys/components/api-keys-dialogs'
import { ApiKeysPrimaryButtons } from '@/features/keys/components/api-keys-primary-buttons'
import { ApiKeysProvider } from '@/features/keys/components/api-keys-provider'
import { ApiKeysTable } from '@/features/keys/components/api-keys-table'

export function UserApiKeysDrawer(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  user: { id: number; username: string }
}) {
  const { t } = useTranslation()
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent className={sideDrawerContentClassName('sm:max-w-6xl')}>
        <SheetHeader className={sideDrawerHeaderClassName()}>
          <SheetTitle>{t('Key management')}</SheetTitle>
          <SheetDescription className='break-all'>
            {props.user.username} (ID: {props.user.id})
          </SheetDescription>
        </SheetHeader>
        {props.open && (
          <ApiKeysProvider owner={props.user}>
            <div className='flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4 sm:p-6'>
              <ApiKeysPrimaryButtons />
              <ApiKeysTable />
            </div>
            <ApiKeysDialogs />
          </ApiKeysProvider>
        )}
      </SheetContent>
    </Sheet>
  )
}
