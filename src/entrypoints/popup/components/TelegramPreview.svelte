<script lang="ts">
  import type { TelegramMessageFormatOptions } from '../../../lib/types';
  import {
    formatTelegramMessage,
    buildStudyReplyMarkup,
    buildSampleStudy,
    telegramHtmlToPreviewHtml,
  } from '../../../lib/telegram-format';

  let { format }: { format: TelegramMessageFormatOptions } = $props();

  // Fixed sample study — same one the "Send test" button uses — so the preview is deterministic and
  // exercises every field. Date fields aren't rendered, so a constant is fine.
  const sampleStudy = buildSampleStudy('2024-01-01T00:00:00.000Z');

  // Re-renders whenever a format toggle changes (deep reactivity on the message_format object).
  const bodyHtml = $derived(telegramHtmlToPreviewHtml(formatTelegramMessage(sampleStudy, null, format)));
  const showButton = $derived(!!buildStudyReplyMarkup(sampleStudy, format));
</script>

<div class="mt-1">
  <div class="text-[12.5px] text-base-content/70 font-medium mb-1.5">Live preview</div>
  <div class="tg-preview rounded-lg bg-base-200/60 border border-base-300 p-2.5">
    <div class="tg-bubble bg-base-100 border border-base-300 rounded-xl rounded-tl-sm shadow-sm px-2.5 py-1.5 max-w-full">
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- fixed, trusted sample; no user input -->
      <div class="text-[12px] leading-snug text-base-content break-words">{@html bodyHtml}</div>
      {#if showButton}
        <div class="mt-1.5 pt-1.5 border-t border-base-300 text-center text-[12px] font-medium text-info">
          📋 Open study
        </div>
      {/if}
    </div>
    <div class="text-[10px] text-base-content/40 mt-1.5 leading-snug">
      Exactly what Telegram will show for a matching study. Updates as you change the options above.
    </div>
  </div>
</div>

<style>
  /* Telegram renders these inline style tags; scope a little spacing so multi-line bodies read well. */
  .tg-bubble :global(b) {
    font-weight: 700;
  }
  .tg-bubble :global(i) {
    opacity: 0.75;
  }
  .tg-bubble :global(s) {
    opacity: 0.6;
  }
</style>
