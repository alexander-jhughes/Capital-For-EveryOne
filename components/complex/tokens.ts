// Tailwind classes for the design tokens, so every size stays tied to a CSS
// variable and restyles when data-mode flips. The fallbacks apply until the
// tokens are defined in globals.css. Class names must stay complete literals
// for Tailwind to find them.

export const textSmall = "text-[length:calc(var(--text-base,16px)*0.875)]"
export const textBase = "text-[length:var(--text-base,16px)]"
export const textLarge = "text-[length:var(--text-lg,20px)]"
export const textDisplay = "text-[length:calc(var(--text-lg,20px)*1.6)]"

export const rounded = "rounded-[var(--radius,8px)]"
export const padding = "p-[var(--density,12px)]"
export const gap = "gap-[var(--density,12px)]"
export const gapTight = "gap-[calc(var(--density,12px)*0.33)]"
export const targetHeight = "min-h-[var(--target-min,44px)]"

/** Applies the radius and spacing tokens to a shadcn Card. */
export const card = `${rounded} [--card-spacing:var(--density,12px)]`
