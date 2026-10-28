export function AppIcon({ name }: {
  name: "saves" | "favorites" | "archive" | "zen" | "tags" | "sync" | "settings" | "back" | "edit" | "external";
}) {
  const paths = {
    saves: <><path d="M5 3h14v18l-7-4-7 4z" /><path d="M9 7h6" /></>,
    favorites: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z" />,
    archive: <><path d="M3 4h18v5H3zM5 9v12h14V9M9 13h6" /></>,
    zen: <><path d="M5 3h10l4 4v14H5zM14 3v5h5M9 12h6M9 16h4" /></>,
    tags: <><path d="M3 3h8l10 10-8 8L3 11z" /><circle cx="7.5" cy="7.5" r="1" /></>,
    sync: <><path d="M20 10a8 8 0 0 0-14-4L3 9m0-6v6h6M4 14a8 8 0 0 0 14 4l3-3m0 6v-6h-6" /></>,
    back: <path d="m10 5-7 7 7 7M3 12h18" />,
    edit: <><path d="m16 3 5 5-12 12-6 1 1-6zM13 6l5 5" /></>,
    external: <path d="M14 3h7v7M21 3 10 14M10 3H3v18h18v-7" />,
    settings: <><path d="m9.7 4.5.6-2.4h3.4l.6 2.4 1.4.6 2-1.3 2.5 2.5-1.3 2 .6 1.4 2.4.6v3.4l-2.4.6-.6 1.4 1.3 2-2.5 2.5-2-1.3-1.4.6-.6 2.4h-3.4l-.6-2.4-1.4-.6-2 1.3-2.5-2.5 1.3-2-.6-1.4-2.4-.6v-3.4l2.4-.6.6-1.4-1.3-2 2.5-2.5 2 1.3z" /><circle cx="12" cy="12" r="3" /></>,
  };
  return <svg aria-hidden="true" className="app-icon" viewBox="0 0 24 24">{paths[name]}</svg>;
}

