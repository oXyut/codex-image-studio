import {
  type ComponentProps,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { ContextMenu as Primitive } from "radix-ui";
import { cn } from "@/lib/utils";

export function ContextMenuItem({
  className,
  variant = "default",
  ...props
}: ComponentProps<typeof Primitive.Item> & {
  variant?: "default" | "destructive";
}) {
  return (
    <Primitive.Item
      data-slot="context-menu-item"
      data-variant={variant}
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

export function ContextMenuLabel({
  className,
  ...props
}: ComponentProps<typeof Primitive.Label>) {
  return (
    <Primitive.Label
      className={cn("px-2 py-1.5 text-sm font-medium", className)}
      {...props}
    />
  );
}

export function ContextMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof Primitive.Separator>) {
  return (
    <Primitive.Separator
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

// asChild keeps buttons, table rows and graph nodes in their existing layout.
// Limit interception to these targets so text fields keep their native menu.
export function openContextMenuWithKeyboard(
  event: KeyboardEvent,
  target = event.target as HTMLElement,
) {
  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
    return false;
  if (target.closest("input, textarea, [contenteditable=true]")) return false;
  event.preventDefault();
  event.stopPropagation();
  const rect = target.getBoundingClientRect();
  target.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }),
  );
  return true;
}

export function ContextMenu({
  children,
  content,
  label,
  className,
}: {
  children: ReactElement;
  content: ReactNode;
  label: string;
  className?: string;
}) {
  return (
    <Primitive.Root>
      <Primitive.Trigger
        asChild
        data-slot="context-menu-trigger"
        onContextMenu={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          openContextMenuWithKeyboard(event);
        }}
      >
        {children}
      </Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          aria-label={label}
          className={cn(
            "z-50 max-h-(--radix-context-menu-content-available-height) min-w-56 max-w-[calc(100vw-2rem)] origin-(--radix-context-menu-content-transform-origin) overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md outline-none",
            className,
          )}
          // Portal clicks still bubble to the trigger's React ancestors.
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {content}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
