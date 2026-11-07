import { CSSProperties, useEffect, useMemo, useState } from 'react';
import {
  Atom,
  Bike,
  BookOpen,
  Bookmark,
  Brain,
  Briefcase,
  Building2,
  Calendar,
  Camera,
  Check,
  ChartColumn,
  Code,
  Coffee,
  Compass,
  Flag,
  FlaskConical,
  Folder as FolderIcon,
  Gamepad2,
  Globe,
  GraduationCap,
  Handshake,
  Heart,
  House,
  Inbox,
  Landmark,
  Leaf,
  Lightbulb,
  LucideIcon,
  Megaphone,
  MessageCircle,
  Mic,
  Music,
  Palette,
  PenTool,
  Plane,
  Rocket,
  Scale,
  Search,
  Shield,
  ShoppingBag,
  Sparkles,
  Star,
  Target,
  Trophy,
  Users,
  Video,
  Wallet,
  Wrench,
  Zap,
} from 'lucide-react';
import { Folder } from './api';
import { cx, Modal } from './ui';

/** Folder colours. Keys are what the server stores; null means "default". */
export const FOLDER_COLORS = {
  slate: { label: 'Slate', ink: '#5b6470', soft: '#eceef0' },
  red: { label: 'Red', ink: '#c2412d', soft: '#fbe6e1' },
  orange: { label: 'Orange', ink: '#c8661a', soft: '#fcebdc' },
  amber: { label: 'Amber', ink: '#a87a0c', soft: '#f8efd2' },
  green: { label: 'Green', ink: '#2f7a4f', soft: '#e1f0e6' },
  teal: { label: 'Teal', ink: '#16807a', soft: '#dcf0ee' },
  blue: { label: 'Blue', ink: '#2f68b8', soft: '#e1ebf8' },
  indigo: { label: 'Indigo', ink: '#5150b5', soft: '#e7e6f8' },
  violet: { label: 'Violet', ink: '#8a47b0', soft: '#f1e5f6' },
  pink: { label: 'Pink', ink: '#bf3f78', soft: '#f9e3ed' },
} as const;
export type FolderColor = keyof typeof FOLDER_COLORS;
const COLOR_KEYS = Object.keys(FOLDER_COLORS) as FolderColor[];
const DEFAULT_LOOK = { ink: '#6b7069', soft: '#ecebe4' };

/** Folder icons. Keys are what the server stores; null means the plain folder. */
export const FOLDER_ICONS: Record<string, { label: string; icon: LucideIcon }> = {
  folder: { label: 'Folder', icon: FolderIcon },
  briefcase: { label: 'Work', icon: Briefcase },
  users: { label: 'Team', icon: Users },
  handshake: { label: 'Clients', icon: Handshake },
  'message-circle': { label: 'Chat', icon: MessageCircle },
  video: { label: 'Calls', icon: Video },
  mic: { label: 'Interviews', icon: Mic },
  calendar: { label: 'Planning', icon: Calendar },
  target: { label: 'Goals', icon: Target },
  flag: { label: 'Milestones', icon: Flag },
  rocket: { label: 'Launch', icon: Rocket },
  lightbulb: { label: 'Ideas', icon: Lightbulb },
  sparkles: { label: 'Sparkles', icon: Sparkles },
  zap: { label: 'Quick', icon: Zap },
  brain: { label: 'Thinking', icon: Brain },
  'chart-column': { label: 'Metrics', icon: ChartColumn },
  wallet: { label: 'Finance', icon: Wallet },
  scale: { label: 'Legal', icon: Scale },
  shield: { label: 'Security', icon: Shield },
  code: { label: 'Engineering', icon: Code },
  wrench: { label: 'Ops', icon: Wrench },
  palette: { label: 'Design', icon: Palette },
  'pen-tool': { label: 'Writing', icon: PenTool },
  megaphone: { label: 'Marketing', icon: Megaphone },
  'shopping-bag': { label: 'Sales', icon: ShoppingBag },
  search: { label: 'Research', icon: Search },
  'flask-conical': { label: 'Lab', icon: FlaskConical },
  atom: { label: 'Science', icon: Atom },
  'graduation-cap': { label: 'Classes', icon: GraduationCap },
  'book-open': { label: 'Reading', icon: BookOpen },
  landmark: { label: 'Institution', icon: Landmark },
  'building-2': { label: 'Office', icon: Building2 },
  house: { label: 'Home', icon: House },
  heart: { label: 'Personal', icon: Heart },
  star: { label: 'Favourites', icon: Star },
  bookmark: { label: 'Saved', icon: Bookmark },
  inbox: { label: 'Inbox', icon: Inbox },
  globe: { label: 'World', icon: Globe },
  plane: { label: 'Travel', icon: Plane },
  compass: { label: 'Explore', icon: Compass },
  coffee: { label: 'Coffee chats', icon: Coffee },
  leaf: { label: 'Nature', icon: Leaf },
  music: { label: 'Music', icon: Music },
  camera: { label: 'Media', icon: Camera },
  'gamepad-2': { label: 'Games', icon: Gamepad2 },
  bike: { label: 'Sport', icon: Bike },
  trophy: { label: 'Wins', icon: Trophy },
};
const ICON_KEYS = Object.keys(FOLDER_ICONS);

type Look = Pick<Folder, 'color' | 'icon'>;

export function folderLook(f: Look | null | undefined) {
  const c = f?.color && f.color in FOLDER_COLORS ? FOLDER_COLORS[f.color as FolderColor] : DEFAULT_LOOK;
  const Icon = (f?.icon && FOLDER_ICONS[f.icon]?.icon) || FolderIcon;
  return { ...c, Icon };
}

/** CSS variables that tint a subtree in the folder's colour. */
export function folderVars(f: Look | null | undefined): CSSProperties {
  const { ink, soft } = folderLook(f);
  return { '--folder': ink, '--folder-soft': soft } as CSSProperties;
}

/** The folder's icon drawn in its colour. */
export function FolderGlyph({ folder, size = 15, className }: { folder: Look | null | undefined; size?: number; className?: string }) {
  const { ink, Icon } = folderLook(folder);
  return <Icon size={size} className={className} style={{ color: ink, flexShrink: 0 }} aria-hidden />;
}

/** The folder's icon on a soft tile of its colour. */
export function FolderTile({ folder, size = 40, className }: { folder: Look | null | undefined; size?: number; className?: string }) {
  const { ink, soft, Icon } = folderLook(folder);
  return (
    <span className={cx('folder-tile', className)} style={{ width: size, height: size, background: soft, color: ink }} aria-hidden>
      <Icon size={Math.round(size * 0.5)} />
    </span>
  );
}

/** A colour for a brand-new folder, so a fresh notebook isn't all grey. */
export function nextFolderColor(existing: Folder[]): FolderColor {
  const used = new Map<string, number>();
  for (const f of existing) if (f.color) used.set(f.color, (used.get(f.color) || 0) + 1);
  const order: FolderColor[] = ['blue', 'green', 'orange', 'violet', 'teal', 'pink', 'amber', 'indigo', 'red', 'slate'];
  return [...order].sort((a, b) => (used.get(a) || 0) - (used.get(b) || 0) || order.indexOf(a) - order.indexOf(b))[0];
}

export type FolderDraft = { name: string; color: string | null; icon: string | null };

/** Create or customise a folder: name, colour and icon, with a live preview. */
export function FolderDialog({
  open,
  folder,
  suggestedColor,
  onClose,
  onSave,
}: {
  open: boolean;
  /** Existing folder to customise; omit to create one. */
  folder?: Folder | null;
  suggestedColor?: string;
  onClose: () => void;
  onSave: (draft: FolderDraft) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<FolderDraft>({ name: '', color: null, icon: null });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setDraft(folder ? { name: folder.name, color: folder.color, icon: folder.icon } : { name: '', color: suggestedColor || 'blue', icon: null });
  }, [open, folder, suggestedColor]);
  const look = folderLook(draft);
  const icons = useMemo(() => ICON_KEYS, []);
  const valid = !!draft.name.trim();

  async function save() {
    if (!valid || busy) return;
    setBusy(true);
    const ok = await onSave({ ...draft, name: draft.name.trim() });
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={folder ? 'Customize folder' : 'New folder'}
      description={folder ? 'Pick a name, colour and icon. It shows up everywhere this folder does.' : 'Give it a name, then make it yours.'}
      footer={
        <>
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="folder-dialog-form" className="primary" disabled={!valid || busy}>
            {folder ? 'Save' : 'Create folder'}
          </button>
        </>
      }
    >
      <form
        id="folder-dialog-form"
        className="folder-dialog"
        style={folderVars(draft)}
        onSubmit={e => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="folder-preview">
          <span className="folder-tile" style={{ width: 52, height: 52, background: look.soft, color: look.ink }} aria-hidden>
            <look.Icon size={26} />
          </span>
          <input
            data-autofocus
            aria-label="Folder name"
            placeholder="Folder name"
            maxLength={200}
            value={draft.name}
            onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
          />
        </div>

        <fieldset className="folder-field">
          <legend>Colour</legend>
          <div className="swatches" role="radiogroup" aria-label="Folder colour">
            {COLOR_KEYS.map(k => {
              const on = draft.color === k;
              return (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={FOLDER_COLORS[k].label}
                  title={FOLDER_COLORS[k].label}
                  className={cx('swatch', on && 'on')}
                  style={{ '--swatch': FOLDER_COLORS[k].ink } as CSSProperties}
                  onClick={() => setDraft(d => ({ ...d, color: k }))}
                >
                  {on && <Check size={14} strokeWidth={3} />}
                </button>
              );
            })}
            <button
              type="button"
              role="radio"
              aria-checked={draft.color === null}
              aria-label="No colour"
              title="No colour"
              className={cx('swatch none', draft.color === null && 'on')}
              onClick={() => setDraft(d => ({ ...d, color: null }))}
            />
          </div>
        </fieldset>

        <fieldset className="folder-field">
          <legend>Icon</legend>
          <div className="icon-grid" role="radiogroup" aria-label="Folder icon">
            {icons.map(k => {
              const { icon: Icon, label } = FOLDER_ICONS[k];
              const on = (draft.icon || 'folder') === k;
              return (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={label}
                  title={label}
                  className={cx('icon-choice', on && 'on')}
                  onClick={() => setDraft(d => ({ ...d, icon: k === 'folder' ? null : k }))}
                >
                  <Icon size={18} />
                </button>
              );
            })}
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
