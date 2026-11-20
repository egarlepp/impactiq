import React from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../../lib/utils.js'

export type ChipVariant = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent'
export type ChipSize = 'xs' | 'sm'

interface ChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: ChipVariant
  size?: ChipSize
  icon?: LucideIcon
  children?: React.ReactNode
}

const VARIANT_CLASSES: Record<ChipVariant, string> = {
  neutral:
    'border-gray-200 bg-white text-gray-700 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300',
  success:
    'border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200',
  warning:
    'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  danger:
    'border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200',
  info:
    'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200',
  accent:
    'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-300',
}

const SIZE_CLASSES: Record<ChipSize, string> = {
  xs: 'px-1.5 py-0.5 text-[10px]',
  sm: 'px-2 py-0.5 text-[11px]',
}

export function Chip({
  variant = 'neutral',
  size = 'sm',
  icon: Icon,
  className,
  children,
  ...rest
}: ChipProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-md border font-medium',
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      )}
      {...rest}
    >
      {Icon ? <Icon className={size === 'xs' ? 'h-2.5 w-2.5' : 'h-3 w-3'} aria-hidden="true" /> : null}
      {children}
    </span>
  )
}
