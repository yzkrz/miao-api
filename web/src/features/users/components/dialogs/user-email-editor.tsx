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
import { useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { handleServerError } from '@/lib/handle-server-error'

// Existing HTML/Markdown components only display content. A native editing
// surface preserves selection/undo while shared controls provide formatting.
export function EmailEditor(props: {
  editorRef: RefObject<HTMLDivElement | null>
  html: string
  onChange: (html: string) => void
  disabled: boolean
}) {
  const { t } = useTranslation()
  const selection = useRef<Range | null>(null)
  const [url, setUrl] = useState('')
  const command = (name: string, value?: string) => {
    if (props.disabled) return
    const editor = props.editorRef.current
    if (!editor) return
    editor.focus()
    const current = window.getSelection()
    if (
      selection.current &&
      editor.contains(selection.current.commonAncestorContainer)
    ) {
      current?.removeAllRanges()
      current?.addRange(selection.current)
    }
    document.execCommand(name, false, value)
    props.onChange(editor.innerHTML)
  }
  const saveSelection = () => {
    const current = window.getSelection()
    if (
      current?.rangeCount &&
      props.editorRef.current?.contains(current.anchorNode)
    ) {
      selection.current = current.getRangeAt(0).cloneRange()
    }
  }
  const insertURL = (image: boolean) => {
    try {
      const parsed = new URL(url)
      if (!['https:', 'http:'].includes(parsed.protocol)) {
        throw new Error('Invalid URL')
      }
      command(image ? 'insertImage' : 'createLink', parsed.href)
      setUrl('')
    } catch {
      toast.error(t('Please enter a valid URL'))
    }
  }
  const upload = async (file: File) => {
    const existing = [
      ...(props.editorRef.current?.querySelectorAll('img[src^="data:"]') ?? []),
    ]
    const bytes = existing.reduce(
      (sum, image) =>
        sum + ((image.getAttribute('src')?.split(',')[1].length ?? 0) * 3) / 4,
      0
    )
    if (
      !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(
        file.type
      ) ||
      existing.length >= 5 ||
      bytes + file.size > 5 * 1024 * 1024
    ) {
      toast.error(
        t('Use up to 5 PNG, JPEG, GIF or WebP images, totaling at most 5 MB.')
      )
      return
    }
    const source = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.addEventListener('load', () => resolve(String(reader.result)), {
        once: true,
      })
      reader.addEventListener('error', () => reject(reader.error), {
        once: true,
      })
      reader.readAsDataURL(file)
    })
    command('insertImage', source)
  }
  const formats = [
    ['bold', t('Bold')],
    ['italic', t('Italic')],
    ['underline', t('Underline')],
    ['insertUnorderedList', t('Bulleted list')],
    ['insertOrderedList', t('Numbered list')],
    ['justifyLeft', t('Align left')],
    ['justifyCenter', t('Align center')],
    ['justifyRight', t('Align right')],
    ['undo', t('Undo')],
    ['redo', t('Redo')],
    ['removeFormat', t('Clear formatting')],
  ]
  return (
    <div className='space-y-2'>
      <Label id='email-body-label'>{t('Message')}</Label>
      <div
        role='group'
        aria-label={t('Formatting')}
        className='flex flex-wrap gap-1'
      >
        {formats.map(([name, label]) => (
          <Button
            key={name}
            type='button'
            variant='outline'
            size='sm'
            disabled={props.disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => command(name)}
          >
            {label}
          </Button>
        ))}
        <Button
          type='button'
          variant='outline'
          size='sm'
          disabled={props.disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => command('formatBlock', 'h2')}
        >
          {t('Heading')}
        </Button>
        <Button
          type='button'
          variant='outline'
          size='sm'
          disabled={props.disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => command('formatBlock', 'p')}
        >
          {t('Paragraph')}
        </Button>
      </div>
      <div
        ref={(node) => {
          props.editorRef.current = node
          if (node && node.innerHTML !== props.html) node.innerHTML = props.html
        }}
        role='textbox'
        aria-labelledby='email-body-label'
        aria-multiline='true'
        aria-disabled={props.disabled}
        tabIndex={0}
        contentEditable={!props.disabled}
        suppressContentEditableWarning
        className='focus-visible:ring-ring [&_a]:text-primary min-h-56 max-w-none rounded-md border p-3 break-words outline-none focus-visible:ring-2 [&_a]:underline [&_h2]:text-xl [&_h2]:font-semibold [&_img]:max-w-full [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-6'
        onInput={(event) => props.onChange(event.currentTarget.innerHTML)}
        onKeyUp={saveSelection}
        onMouseUp={saveSelection}
        onBlur={saveSelection}
        onPaste={(event) => {
          event.preventDefault()
          command('insertText', event.clipboardData.getData('text/plain'))
        }}
        onDrop={(event) => event.preventDefault()}
      />
      <div className='flex flex-wrap gap-2'>
        <Input
          aria-label={t('URL')}
          placeholder='https://'
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          disabled={props.disabled}
          className='min-w-40 flex-1'
        />
        <Button
          type='button'
          variant='outline'
          disabled={props.disabled || !url}
          onClick={() => insertURL(false)}
        >
          {t('Insert link')}
        </Button>
        <Button
          type='button'
          variant='outline'
          disabled={props.disabled || !url}
          onClick={() => insertURL(true)}
        >
          {t('Insert image')}
        </Button>
      </div>
      <Label htmlFor='email-image'>{t('Upload image')}</Label>
      <Input
        id='email-image'
        type='file'
        accept='image/png,image/jpeg,image/gif,image/webp'
        disabled={props.disabled}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void upload(file).catch(handleServerError)
        }}
      />
      <p className='text-muted-foreground text-xs'>
        {t('Use up to 5 PNG, JPEG, GIF or WebP images, totaling at most 5 MB.')}
      </p>
    </div>
  )
}
