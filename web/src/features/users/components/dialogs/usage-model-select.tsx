/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { Check, ChevronDown } from 'lucide-react'
import { useState, type ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

import type { UserLimitModel } from '../../api'

export function UsageModelSelect(props: {
  id?: string
  selected: string[]
  onChange: (models: string[]) => void
  candidates: UserLimitModel[]
  disabled?: boolean
  'aria-describedby'?: ComponentProps<'input'>['aria-describedby']
  'aria-invalid'?: ComponentProps<'input'>['aria-invalid']
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleModels = props.candidates.filter(
    (item) =>
      !normalizedQuery ||
      item.model.toLocaleLowerCase().startsWith(normalizedQuery)
  )
  const visibleModelNames = visibleModels.map((item) => item.model)
  const visibleSelectedCount = visibleModelNames.filter((model) =>
    props.selected.includes(model)
  ).length
  const allVisibleSelected =
    visibleModelNames.length > 0 &&
    visibleSelectedCount === visibleModelNames.length
  const selectedLabels = props.selected.map(
    (model) =>
      props.candidates.find((item) => item.model === model)?.model ?? model
  )

  const toggleModel = (model: string) => {
    props.onChange(
      props.selected.includes(model)
        ? props.selected.filter((selected) => selected !== model)
        : [...props.selected, model]
    )
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) setQuery('')
      }}
    >
      <PopoverTrigger
        render={
          <Button
            id={props.id}
            type='button'
            variant='outline'
            role='combobox'
            aria-label={t('Applicable models')}
            aria-describedby={props['aria-describedby']}
            aria-invalid={props['aria-invalid']}
            disabled={props.disabled}
            className='w-full justify-between font-normal'
          />
        }
      >
        <span className='flex min-w-0 items-center gap-1.5'>
          <span className='truncate'>
            {selectedLabels.length === 0
              ? t('All models (leave empty)')
              : selectedLabels[0]}
          </span>
          {selectedLabels.length > 1 && (
            <span className='text-muted-foreground shrink-0'>
              {t('+{{count}} more', { count: selectedLabels.length - 1 })}
            </span>
          )}
        </span>
        <ChevronDown
          className='size-4 shrink-0 opacity-50'
          aria-hidden='true'
        />
      </PopoverTrigger>
      <PopoverContent
        align='start'
        className='w-[var(--anchor-width)] min-w-[min(20rem,calc(100vw-2rem))] overflow-hidden p-0'
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t('Search models')}
            aria-label={t('Search models')}
            value={query}
            onValueChange={setQuery}
            aria-describedby={props['aria-describedby']}
            aria-invalid={props['aria-invalid']}
          />
          <div className='flex items-center gap-2 px-3 py-2'>
            <Checkbox
              checked={allVisibleSelected}
              disabled={visibleModelNames.length === 0}
              aria-label={t('Select all matching models')}
              onCheckedChange={(checked) => {
                const selected = new Set(props.selected)
                if (checked) {
                  visibleModelNames.forEach((model) => selected.add(model))
                } else {
                  visibleModelNames.forEach((model) => selected.delete(model))
                }
                props.onChange([...selected])
              }}
            />
            <span className='text-muted-foreground text-sm'>
              {t('Select all matching models')}
            </span>
          </div>
          <CommandList className='max-h-72'>
            <CommandEmpty>{t('No matching items')}</CommandEmpty>
            <CommandGroup>
              {visibleModels.map((item) => {
                const selected = props.selected.includes(item.model)
                return (
                  <CommandItem
                    key={item.model}
                    value={item.model}
                    onSelect={() => toggleModel(item.model)}
                    aria-checked={selected}
                    className='data-[selected=true]:bg-muted'
                  >
                    <Check
                      aria-hidden='true'
                      className={
                        selected ? 'size-4 opacity-100' : 'size-4 opacity-0'
                      }
                    />
                    <span className='truncate'>{item.model}</span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
