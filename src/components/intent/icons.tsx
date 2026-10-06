/**
 * The icons Intent UI's components draw, under the names upstream imports from
 * Heroicons, served by the application's own icon set (lucide-react). Each is
 * marked `data-slot="icon"` as Heroicons are, because the components size and
 * colour their icons by that slot; left and right chevrons turn round in a
 * right-to-left page.
 */
import type { LucideIcon, LucideProps } from 'lucide-react';
import {
  CalendarDays,
  CalendarRange,
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  CircleAlert,
  CircleCheck,
  CircleX,
  Folder,
  Info,
  Menu,
  Minus,
  Paperclip,
  Plus,
  Search,
  X,
} from 'lucide-react';
import { cn } from './cn';

function icon(Glyph: LucideIcon, name: string, mirrored = false) {
  function Icon({ className, ...props }: LucideProps) {
    return (
      <Glyph
        aria-hidden="true"
        data-slot="icon"
        strokeWidth={2}
        {...props}
        className={cn(mirrored && 'rtl:-scale-x-100', className)}
      />
    );
  }
  Icon.displayName = name;
  return Icon;
}

export const Bars2Icon = icon(Menu, 'Bars2Icon');
export const CalendarDateRangeIcon = icon(CalendarRange, 'CalendarDateRangeIcon');
export const CalendarDaysIcon = icon(CalendarDays, 'CalendarDaysIcon');
export const CameraIcon = icon(Camera, 'CameraIcon');
export const CheckCircleIcon = icon(CircleCheck, 'CheckCircleIcon');
export const CheckIcon = icon(Check, 'CheckIcon');
export const ChevronDownIcon = icon(ChevronDown, 'ChevronDownIcon');
export const ChevronLeftIcon = icon(ChevronLeft, 'ChevronLeftIcon', true);
export const ChevronRightIcon = icon(ChevronRight, 'ChevronRightIcon', true);
export const ChevronUpDownIcon = icon(ChevronsUpDown, 'ChevronUpDownIcon');
export const ExclamationCircleIcon = icon(CircleAlert, 'ExclamationCircleIcon');
export const FolderIcon = icon(Folder, 'FolderIcon');
export const InformationCircleIcon = icon(Info, 'InformationCircleIcon');
export const MagnifyingGlassIcon = icon(Search, 'MagnifyingGlassIcon');
export const MinusIcon = icon(Minus, 'MinusIcon');
export const PaperClipIcon = icon(Paperclip, 'PaperClipIcon');
export const PlusIcon = icon(Plus, 'PlusIcon');
export const XCircleIcon = icon(CircleX, 'XCircleIcon');
export const XMarkIcon = icon(X, 'XMarkIcon');
