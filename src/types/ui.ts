export interface TooltipOptions {
    title?: string;
    placement?: 'top' | 'bottom' | 'left' | 'right';
    delay?: number | { show: number; hide: number };
}
