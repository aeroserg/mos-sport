import {
  DEFAULT_NOTIFY_MODES,
  DURATION_OPTIONS,
  SUPPORTED_MONITOR_EVENT_TYPES,
  TELEGRAM_API_BASE,
  TELEGRAM_POLL_TIMEOUT_SECONDS,
  VENUES,
} from "../config";
import {
  clearState,
  createSubscription,
  deactivateSubscriptionForChat,
  getKv,
  getState,
  listSubscriptionsByChat,
  saveUser,
  setKv,
  setState,
} from "../db";
import {
  InlineKeyboardMarkup,
  Subscription,
  TelegramCallbackQuery,
  TelegramMessage,
  TelegramUpdate,
  WizardState,
} from "../types";
import {
  answerCallbackQuery,
  editTelegramMessage,
  getTelegramUpdates,
  sendTelegramMessage,
} from "./telegram";
import {
  formatDateHuman,
  getCurrentMskContext,
  parseFlexibleDateInput,
} from "../utils/date";
import { getEventTypeLabel, getVenueLabel } from "../utils/domain";

let telegramLoopStarted = false;

function normalizeNotifyModes(modes: readonly string[]): string[] {
  return Array.from(new Set(["ready", ...modes.map(String)]));
}

function isAlertMessageText(text?: string): boolean {
  return String(text || "").includes("Найдены слоты по подписке");
}

function button(
  text: string,
  data: string,
): { text: string; callback_data: string } {
  return { text, callback_data: data };
}

function createInitialWizardState(messageId?: number | null): WizardState {
  return {
    flow: "subscription",
    step: "venues",
    history: [],
    message_id: messageId || null,
    data: {
      venues: [],
      event_types: [],
      durations: [],
      min_raw_tickets: 1,
      date_filter: "",
      notify_modes: normalizeNotifyModes([...DEFAULT_NOTIFY_MODES]),
    },
  };
}

function popHistory(state: WizardState): WizardState {
  const history = [...state.history];
  const previous = history.pop();
  return {
    ...state,
    history,
    step: previous || "venues",
  };
}

function subscriptionSummary(
  subscriptionData: Pick<
    Subscription,
    | "venues"
    | "event_types"
    | "durations"
    | "min_raw_tickets"
    | "date_filter"
    | "notify_modes"
  >,
): string {
  const venuesText = subscriptionData.venues.map(getVenueLabel).join(", ");
  const eventTypesText = subscriptionData.event_types
    .map(getEventTypeLabel)
    .join(", ");
  const durationsText = subscriptionData.durations
    .map((item) => `${item} мин`)
    .join(", ");
  const notifyModesText = formatNotifyModes(subscriptionData.notify_modes);

  return [
    `Площадки: ${venuesText || "—"}`,
    `Форматы: ${eventTypesText || "—"}`,
    `Длительность: ${durationsText || "—"}`,
    `Мин. билетов (raw): ${subscriptionData.min_raw_tickets || "—"}`,
    `Дата: ${subscriptionData.date_filter ? formatDateHuman(subscriptionData.date_filter) : "—"}`,
    `Когда уведомлять:\n- ${notifyModesText}`,
  ].join("\n");
}

function formatNotifyModes(modes: string[]): string {
  const normalized = new Set(normalizeNotifyModes(modes));
  const labels: string[] = [];

  if (normalized.has("ready")) {
    labels.push("всегда: когда слот уже доступен для бронирования на сайте");
  }
  if (normalized.has("api_visible")) {
    labels.push("дополнительно: когда слот появился в API");
  }
  if (normalized.has("disabled_visible")) {
    labels.push("дополнительно: когда слот серый / выключен");
  }

  return labels.join("\n- ");
}

function buildMainMenuKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button("Подписаться на обновления", "menu|subscribe")],
      [button("Мои подписки", "menu|list")],
      [button("Отписаться", "menu|unsubscribe")],
    ],
  };
}

function buildStepKeyboard(state: WizardState): InlineKeyboardMarkup {
  const data = state.data;

  if (state.step === "venues") {
    const selected = new Set(data.venues.map(String));
    const rows = Object.values(VENUES)
      .filter((venue) => !selected.has(String(venue.id)))
      .map((venue) => [button(venue.title, `sub|venues|add|${venue.id}`)]);

    rows.push([button("Все площадки", "sub|venues|all")]);
    if (selected.size > 0) {
      rows.push([button("Готово", "sub|venues|done")]);
    }
    rows.push([button("Отмена", "sub|cancel")]);
    return { inline_keyboard: rows };
  }

  if (state.step === "event_types") {
    const selected = new Set(data.event_types.map(String));
    const rows = [...SUPPORTED_MONITOR_EVENT_TYPES]
      .filter((eventType) => !selected.has(String(eventType)))
      .map((eventType) => [
        button(
          getEventTypeLabel(eventType),
          `sub|event_types|add|${eventType}`,
        ),
      ]);

    rows.push([button("Все форматы", "sub|event_types|all")]);
    if (selected.size > 0) {
      rows.push([button("Готово", "sub|event_types|done")]);
    }
    rows.push([button("Назад", "sub|back"), button("Отмена", "sub|cancel")]);
    return { inline_keyboard: rows };
  }

  if (state.step === "durations") {
    const selected = new Set(data.durations.map(Number));
    const rows = [...DURATION_OPTIONS]
      .filter((duration) => !selected.has(Number(duration)))
      .map((duration) => [
        button(`${duration} минут`, `sub|durations|add|${duration}`),
      ]);

    rows.push([button("Все длительности", "sub|durations|all")]);
    if (selected.size > 0) {
      rows.push([button("Готово", "sub|durations|done")]);
    }
    rows.push([button("Назад", "sub|back"), button("Отмена", "sub|cancel")]);
    return { inline_keyboard: rows };
  }

  if (state.step === "tickets") {
    return {
      inline_keyboard: [
        [1, 2].map((value) => button(`${value}`, `sub|tickets|set|${value}`)),
        [3, 4].map((value) => button(`${value}`, `sub|tickets|set|${value}`)),
        [button("Назад", "sub|back"), button("Отмена", "sub|cancel")],
      ],
    };
  }

  if (state.step === "date_input") {
    return {
      inline_keyboard: [
        [button("Назад", "sub|back"), button("Отмена", "sub|cancel")],
      ],
    };
  }

  return {
    inline_keyboard: [
      [
        button(
          "Дополнительно: когда слот появился в API",
          "sub|notify|add|api_visible",
        ),
      ],
      [
        button(
          "Дополнительно: когда слот серый / выключен",
          "sub|notify|add|disabled_visible",
        ),
      ],
      [button("Без доп. уведомлений", "sub|notify|default")],
      [button("Сохранить подписку", "sub|notify|done")],
      [button("Назад", "sub|back"), button("Отмена", "sub|cancel")],
    ],
  };
}

function buildStepText(state: WizardState): string {
  const data = state.data;
  if (state.step === "venues") {
    return [
      "Шаг 1 из 6",
      "Выберите площадки для подписки.",
      "",
      `Сейчас выбрано: ${data.venues.length ? data.venues.map(getVenueLabel).join(", ") : "ничего"}`,
    ].join("\n");
  }

  if (state.step === "event_types") {
    return [
      "Шаг 2 из 6",
      "Выберите форматы.",
      "",
      `Сейчас выбрано: ${data.event_types.length ? data.event_types.map(getEventTypeLabel).join(", ") : "ничего"}`,
    ].join("\n");
  }

  if (state.step === "durations") {
    return [
      "Шаг 3 из 6",
      "Выберите длительность сеансов.",
      "",
      `Сейчас выбрано: ${data.durations.length ? data.durations.map((item) => `${item} мин`).join(", ") : "ничего"}`,
    ].join("\n");
  }

  if (state.step === "tickets") {
    return [
      "Шаг 4 из 6",
      "Выберите минимальное количество билетов по raw_available_tickets.",
      "Обычно реально доступны 1–4 билета.",
      "Если вы выберете 2, а будет доступен 1 - мы не пришлем уведомление!",
    ].join("\n");
  }

  if (state.step === "date_input") {
    return [
      "Шаг 5 из 6",
      "Отправьте дату сообщением.",
      "Поддерживаются форматы: 26, 26.07, 26/07/2026, 2026-07-26, 26 июля.",
      "Кнопок для даты нет.",
    ].join("\n");
  }

  const currentDate = getCurrentMskContext().date;
  const isFutureBeyondOpenWindow =
    data.date_filter && data.date_filter > currentDate;
  const warning = isFutureBeyondOpenWindow
    ? "Мы всегда пришлем уведомление, когда слот реально станет доступен для бронирования на сайте."
    : "Мы всегда пришлем уведомление, когда слот реально можно бронировать на сайте.";

  return [
    "Шаг 6 из 6",
    warning,
    "Дополнительно можно включить ранние уведомления: когда слот только появился в API или когда он есть, но ещё серый / выключен.",
    "",
    subscriptionSummary(data as Subscription),
  ].join("\n");
}

async function renderMenu(
  chatId: string,
  messageId?: number | null,
): Promise<void> {
  const text = [
    "Бот слежения за слотами Mos Sport.",
    "",
    "Можно подписаться на площадки, форматы, длительности, дату и минимальное количество билетов.",
  ].join("\n");

  if (messageId) {
    await editTelegramMessage(chatId, messageId, text, buildMainMenuKeyboard());
    return;
  }

  await sendTelegramMessage(chatId, text, buildMainMenuKeyboard());
}

async function renderMenuAsNewMessage(chatId: string): Promise<void> {
  await renderMenu(chatId, null);
}

async function renderWizard(chatId: string, state: WizardState): Promise<void> {
  const text = buildStepText(state);
  const keyboard = buildStepKeyboard(state);
  let messageId = state.message_id;

  if (messageId) {
    await editTelegramMessage(chatId, messageId, text, keyboard);
  } else {
    messageId = await sendTelegramMessage(chatId, text, keyboard);
  }

  setState(chatId, {
    ...state,
    message_id: messageId,
  });
}

async function renderSubscriptionsList(
  chatId: string,
  messageId: number | null,
  mode: "list" | "unsubscribe",
): Promise<void> {
  const subscriptions = listSubscriptionsByChat(chatId).filter(
    (subscription) => subscription.active,
  );
  const text = subscriptions.length
    ? subscriptions
        .map((subscription) =>
          [
            `#${subscription.id} — активна`,
            subscriptionSummary(subscription),
          ].join("\n"),
        )
        .join("\n\n")
    : "Активных подписок нет.";

  const rows = subscriptions
    .map((subscription) => [
      button(
        mode === "unsubscribe"
          ? `Отключить #${subscription.id}`
          : `Подписка #${subscription.id}`,
        mode === "unsubscribe" ? `unsub|${subscription.id}` : "noop|list",
      ),
    ]);

  rows.push([button("Назад в меню", "menu|home")]);
  const replyMarkup = { inline_keyboard: rows };

  if (messageId) {
    await editTelegramMessage(chatId, messageId, text, replyMarkup);
    return;
  }

  await sendTelegramMessage(chatId, text, replyMarkup);
}

async function handleSubscriptionCallback(
  chatId: string,
  messageId: number,
  parts: string[],
): Promise<void> {
  const state = getState(chatId) || createInitialWizardState(messageId);
  state.message_id = messageId;
  const category = parts[1];
  const action = parts[2];
  const value = parts[3];

  if (category === "cancel") {
    clearState(chatId);
    await renderMenu(chatId, messageId);
    return;
  }

  if (category === "back") {
    await renderWizard(chatId, popHistory(state));
    return;
  }

  if (category === "venues") {
    if (action === "add" && value) {
      state.data.venues = Array.from(new Set([...state.data.venues, value]));
      await renderWizard(chatId, state);
      return;
    }
    if (action === "all") {
      state.data.venues = Object.keys(VENUES);
      state.history.push(state.step);
      state.step = "event_types";
      await renderWizard(chatId, state);
      return;
    }
    if (action === "done" && state.data.venues.length) {
      state.history.push(state.step);
      state.step = "event_types";
      await renderWizard(chatId, state);
      return;
    }
  }

  if (category === "event_types") {
    if (action === "add" && value) {
      state.data.event_types = Array.from(
        new Set([...state.data.event_types, value]),
      );
      await renderWizard(chatId, state);
      return;
    }
    if (action === "all") {
      state.data.event_types = [...SUPPORTED_MONITOR_EVENT_TYPES];
      state.history.push(state.step);
      state.step = "durations";
      await renderWizard(chatId, state);
      return;
    }
    if (action === "done" && state.data.event_types.length) {
      state.history.push(state.step);
      state.step = "durations";
      await renderWizard(chatId, state);
      return;
    }
  }

  if (category === "durations") {
    if (action === "add" && value) {
      state.data.durations = Array.from(
        new Set([...state.data.durations, Number(value)]),
      ).sort((left, right) => left - right);
      await renderWizard(chatId, state);
      return;
    }
    if (action === "all") {
      state.data.durations = [...DURATION_OPTIONS];
      state.history.push(state.step);
      state.step = "tickets";
      await renderWizard(chatId, state);
      return;
    }
    if (action === "done" && state.data.durations.length) {
      state.history.push(state.step);
      state.step = "tickets";
      await renderWizard(chatId, state);
      return;
    }
  }

  if (category === "tickets" && action === "set" && value) {
    state.data.min_raw_tickets = Number(value) || 1;
    state.history.push(state.step);
    state.step = "date_input";
    await renderWizard(chatId, state);
    return;
  }

  if (category === "notify") {
    if (action === "add" && value) {
      state.data.notify_modes = normalizeNotifyModes([
        ...state.data.notify_modes,
        value,
      ]);
      await renderWizard(chatId, state);
      return;
    }

    const subscriptionId = createSubscription({
      chat_id: chatId,
      venues: state.data.venues.length
        ? state.data.venues
        : Object.keys(VENUES),
      event_types: state.data.event_types.length
        ? state.data.event_types
        : ["free_play"],
      durations: state.data.durations.length ? state.data.durations : [60],
      min_raw_tickets: state.data.min_raw_tickets || 1,
      date_filter: state.data.date_filter,
      notify_modes: normalizeNotifyModes(
        action === "default"
          ? [...DEFAULT_NOTIFY_MODES]
          : state.data.notify_modes.length
            ? state.data.notify_modes
            : [...DEFAULT_NOTIFY_MODES],
      ),
    });
    clearState(chatId);
    await editTelegramMessage(
      chatId,
      messageId,
      `Подписка #${subscriptionId} сохранена.\n\n${subscriptionSummary(state.data as Subscription)}`,
      {
        inline_keyboard: [[button("В меню", "menu|home")]],
      },
    );
  }
}

async function handleTextMessage(message: TelegramMessage): Promise<void> {
  const chatId = String(message.chat.id);
  saveUser(message.from);

  const text = String(message.text || "").trim();
  if (text === "/start") {
    clearState(chatId);
    await renderMenu(chatId);
    return;
  }

  if (text === "/subscriptions") {
    await renderSubscriptionsList(chatId, null, "list");
    return;
  }

  const state = getState(chatId);
  if (!state || state.step !== "date_input") {
    return;
  }

  const parsedDate = parseFlexibleDateInput(text);
  if (!parsedDate.ok || !parsedDate.date) {
    await sendTelegramMessage(chatId, parsedDate.error || "Не понял дату.", {
      inline_keyboard: [
        [button("Назад", "sub|back"), button("Отмена", "sub|cancel")],
      ],
    });
    return;
  }

  state.data.date_filter = parsedDate.date;
  state.history.push(state.step);
  state.step = "notify_modes";
  state.message_id = null;
  await renderWizard(chatId, state);
}

async function handleCallbackQuery(
  callbackQuery: TelegramCallbackQuery,
): Promise<void> {
  const chatId = String(
    callbackQuery.from?.id || callbackQuery.message?.chat.id || "",
  );
  const messageId = Number(callbackQuery.message?.message_id || 0);
  const data = String(callbackQuery.data || "");
  if (!chatId || !data) {
    return;
  }

  saveUser(callbackQuery.from);
  const parts = data.split("|");
  const sourceMessageText = callbackQuery.message?.text || "";

  if (parts[0] === "menu") {
    if (parts[1] === "home" && isAlertMessageText(sourceMessageText)) {
      clearState(chatId);
      await renderMenuAsNewMessage(chatId);
      await answerCallbackQuery(callbackQuery.id);
      return;
    }

    if (parts[1] === "subscribe") {
      const state = createInitialWizardState(messageId);
      setState(chatId, state);
      await renderWizard(chatId, state);
    } else if (parts[1] === "list") {
      clearState(chatId);
      await renderSubscriptionsList(chatId, messageId, "list");
    } else if (parts[1] === "unsubscribe") {
      clearState(chatId);
      await renderSubscriptionsList(chatId, messageId, "unsubscribe");
    } else {
      clearState(chatId);
      await renderMenu(chatId, messageId);
    }
    await answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (parts[0] === "menu_new") {
    clearState(chatId);
    await renderMenuAsNewMessage(chatId);
    await answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (parts[0] === "sub") {
    await handleSubscriptionCallback(chatId, messageId, parts);
    await answerCallbackQuery(callbackQuery.id);
    return;
  }

  if (parts[0] === "unsub" && parts[1]) {
    deactivateSubscriptionForChat(
      Number(parts[1]),
      chatId,
      "user_unsubscribed",
    );
    await renderSubscriptionsList(chatId, messageId, "unsubscribe");
    await answerCallbackQuery(callbackQuery.id, "Подписка отключена");
    return;
  }

  await answerCallbackQuery(callbackQuery.id);
}

export async function startTelegramPolling(): Promise<void> {
  if (!TELEGRAM_API_BASE || telegramLoopStarted) {
    return;
  }

  telegramLoopStarted = true;

  while (true) {
    try {
      const offset = Number(getKv("telegram_update_offset") || "0");
      const response = await getTelegramUpdates(
        offset,
        TELEGRAM_POLL_TIMEOUT_SECONDS,
      );

      if (!response.ok) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }

      const updates = response.result || [];
      for (const update of updates as TelegramUpdate[]) {
        setKv("telegram_update_offset", String(Number(update.update_id) + 1));
        if (update.message?.text) {
          await handleTextMessage(update.message);
        }
        if (update.callback_query) {
          await handleCallbackQuery(update.callback_query);
        }
      }
    } catch (error) {
      console.error("Telegram polling failed:", error);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}
