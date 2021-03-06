import IRCClient from 'ircv3';
import { Listener } from 'ircv3/lib/TypedEventEmitter';
import TwitchClient from 'twitch';
import Logger, { LogLevel } from '@d-fischer/logger';

import ChatSubInfo, { ChatSubGiftInfo } from './UserNotices/ChatSubInfo';
import { toChannelName, toUserName } from './Toolkit/UserTools';

import TwitchTagsCapability from './Capabilities/TwitchTagsCapability';
import TwitchCommandsCapability from './Capabilities/TwitchCommandsCapability';
import TwitchMembershipCapability from './Capabilities/TwitchMembershipCapability';

import { ChannelJoin, ChannelPart, Notice } from 'ircv3/lib/Message/MessageTypes/Commands/';
import ClearChat from './Capabilities/TwitchCommandsCapability/MessageTypes/ClearChat';
import HostTarget from './Capabilities/TwitchCommandsCapability/MessageTypes/HostTarget';
import RoomState from './Capabilities/TwitchCommandsCapability/MessageTypes/RoomState';
import UserNotice from './Capabilities/TwitchCommandsCapability/MessageTypes/UserNotice';
import Whisper from './Capabilities/TwitchCommandsCapability/MessageTypes/Whisper';
import { NonEnumerable } from './Toolkit/Decorators';
import TwitchPrivateMessage from './StandardCommands/TwitchPrivateMessage';
import ChatRaidInfo from './UserNotices/ChatRaidInfo';
import ChatRitualInfo from './UserNotices/ChatRitualInfo';
import ChatCommunitySubInfo from './UserNotices/ChatCommunitySubInfo';
import ChatBitsBadgeUpgradeInfo from './UserNotices/ChatBitsBadgeUpgradeInfo';

/**
 * Options for a chat client.
 */
export interface ChatClientOptions {
	/**
	 * Whether to request a token with only read permission.
	 *
	 * Ignored if `legacyScopes` is `true`.
	 */
	readOnly?: boolean;

	/**
	 * Whether to request a token with the old chat permission scope.
	 *
	 * If you're not sure whether this is necessary, just try leaving this off, and if it doesn't work, turn it on and try again.
	 */
	legacyScopes?: boolean;

	/**
	 * The minimum log level of messages that will be sent from the underlying IRC client.
	 */
	logLevel?: LogLevel;

	/**
	 * Whether to connect securely using SSL.
	 *
	 * You should not disable this except for debugging purposes.
	 */
	ssl?: boolean;

	/**
	 * Whether to use a WebSocket to connect to chat.
	 */
	webSocket?: boolean;

	/**
	 * Whether to receive JOIN and PART messages from Twitch chat.
	 */
	requestMembershipEvents?: boolean;
}

/**
 * An interface to Twitch chat.
 *
 * @inheritDoc
 * @hideProtected
 */
export default class ChatClient extends IRCClient {
	private static readonly HOST_MESSAGE_REGEX =
		/(\w+) is now ((?:auto[- ])?)hosting you(?: for (?:up to )?(\d+))?/;

	/** @private */
	@NonEnumerable readonly _twitchClient?: TwitchClient;

	private readonly _useLegacyScopes: boolean;
	private readonly _readOnly: boolean;

	private _authRetrying = false;
	private _authFailureMessage?: string;

	private _chatLogger = new Logger({ name: 'twitch-chat' });

	/**
	 * Fires when a user is timed out from a channel.
	 *
	 * @eventListener
	 * @param channel The channel the user is timed out from.
	 * @param user The timed out user.
	 * @param reason The reason for the timeout.
	 * @param duration The duration of the timeout, in seconds.
	 */
	onTimeout: (handler: (channel: string, user: string, reason: string, duration: number) => void)
		=> Listener = this.registerEvent();

	/**
	 * Fires when a user is permanently banned from a channel.
	 *
	 * @eventListener
	 * @param channel The channel the user is banned from.
	 * @param user The banned user.
	 * @param reason The reason for the ban.
	 */
	onBan: (handler: (channel: string, user: string, reason: string) => void) => Listener = this.registerEvent();

	/**
	 * Fires when a user upgrades their bits badge in a channel.
	 *
	 * @eventListener
	 * @param channel The channel where the bits badge was upgraded.
	 * @param user The user that has upgraded their bits badge.
	 * @param ritualInfo Additional information about the upgrade.
	 * @param msg The raw message that was received.
	 */
	onBitsBadgeUpgrade: (handler: (channel: string, user: string, upgradeInfo: ChatBitsBadgeUpgradeInfo, msg: UserNotice) => void) => Listener = this.registerEvent();

	/**
	 * Fires when the chat of a channel is cleared.
	 *
	 * @eventListener
	 * @param channel The channel whose chat is cleared.
	 */
	onChatClear: (handler: (channel: string) => void) => Listener = this.registerEvent();

	/**
	 * Fires when emote-only mode is toggled in a channel.
	 *
	 * @eventListener
	 * @param channel The channel where emote-only mode is being toggled.
	 * @param enabled Whether emote-only mode is being enabled. If false, it's being disabled.
	 */
	onEmoteOnly: (handler: (channel: string, enabled: boolean) => void) => Listener = this.registerEvent();

	/**
	 * Fires when followers-only mode is toggled in a channel.
	 *
	 * @eventListener
	 * @param channel The channel where followers-only mode is being toggled.
	 * @param enabled Whether followers-only mode is being enabled. If false, it's being disabled.
	 * @param delay The time a user needs to follow the channel to be able to talk. Only available when `enabled === true`.
	 */
	onFollowersOnly: (handler: (channel: string, enabled: boolean, delay?: number) => void)
		=> Listener = this.registerEvent();

	/**
	 * Fires when a channel hosts another channel.
	 *
	 * @eventListener
	 * @param channel The hosting channel.
	 * @param target The channel that is being hosted.
	 * @param viewers The number of viewers in the hosting channel.
	 *
	 *   If you're not logged in as the owner of the channel, this is undefined.
	 */
	onHost: (handler: (channel: string, target: string, viewers?: number) => void) => Listener = this.registerEvent();

	/**
	 * Fires when a channel you're logged in as its owner is being hosted by another channel.
	 *
	 * @eventListener
	 * @param channel The channel that is being hosted.
	 * @param byChannel The hosting channel.
	 * @param auto Whether the host was triggered automatically (by Twitch's auto-host functionality).
	 * @param viewers The number of viewers in the hosting channel.
	 */
	onHosted: (handler: (channel: string, byChannel: string, auto: boolean, viewers?: number) => void)
		=> Listener = this.registerEvent();

	/**
	 * Fires when Twitch tells you the number of hosts you have remaining in the next half hour for the channel
	 * for which you're logged in as owner after hosting a channel.
	 *
	 * @eventListener
	 * @param channel The hosting channel.
	 * @param numberOfHosts The number of hosts remaining in the next half hour.
	 */
	onHostsRemaining: (handler: (channel: string, numberOfHosts: number) => void)
		=> Listener = this.registerEvent();

	/**
	 * Fires when a user joins a channel.
	 *
	 * The join/part events are cached by the Twitch chat server and will be batched and sent every 30-60 seconds.
	 *
	 * @eventListener
	 * @param channel The channel that is being joined.
	 * @param user The user that joined.
	 */
	onJoin: (handler: (channel: string, user: string) => void) => Listener = this.registerEvent();

	/**
	 * Fires when a user leaves ("parts") a channel.
	 *
	 * The join/part events are cached by the Twitch chat server and will be batched and sent every 30-60 seconds.
	 *
	 * @eventListener
	 * @param channel The channel that is being left.
	 * @param user The user that left.
	 */
	onPart: (handler: (channel: string, user: string) => void) => Listener = this.registerEvent();

	/**
	 * Fires when R9K mode is toggled in a channel.
	 *
	 * @eventListener
	 * @param channel The channel where R9K mode is being toggled.
	 * @param enabled Whether R9K mode is being enabled. If false, it's being disabled.
	 */
	onR9k: (handler: (channel: string, enabled: boolean) => void) => Listener = this.registerEvent();

	/**
	 * Fires when host mode is disabled in a channel.
	 *
	 * @eventListener
	 * @param channel The channel where host mode is being disabled.
	 */
	onUnhost: (handler: (channel: string) => void) => Listener = this.registerEvent();

	/**
	 * Fires when a user raids a channel.
	 *
	 * @eventListener
	 * @param channel The channel that was raided.
	 * @param user The user that has raided the channel.
	 * @param raidInfo Additional information about the raid.
	 * @param msg The raw message that was received.
	 */
	onRaid: (handler: (channel: string, user: string, raidInfo: ChatRaidInfo, msg: UserNotice) => void) => Listener = this.registerEvent();

	/**
	 * Fires when a user performs a "ritual" in a channel.
	 *
	 * @eventListener
	 * @param channel The channel where the ritual was performed.
	 * @param user The user that has performed the ritual.
	 * @param ritualInfo Additional information about the ritual.
	 * @param msg The raw message that was received.
	 */
	onRitual: (handler: (channel: string, user: string, ritualInfo: ChatRitualInfo, msg: UserNotice) => void) => Listener = this.registerEvent();

	/**
	 * Fires when slow mode is toggled in a channel.
	 *
	 * @eventListener
	 * @param channel The channel where slow mode is being toggled.
	 * @param enabled Whether slow mode is being enabled. If false, it's being disabled.
	 * @param delay The time a user has to wait between sending messages. Only set when enabling slow mode.
	 */
	onSlow: (handler: (channel: string, enabled: boolean, delay?: number) => void) => Listener = this.registerEvent();

	/**
	 * Fires when sub only mode is toggled in a channel.
	 *
	 * @eventListener
	 * @param channel The channel where sub only mode is being toggled.
	 * @param enabled Whether sub only mode is being enabled. If false, it's being disabled.
	 */
	onSubsOnly: (handler: (channel: string, enabled: boolean) => void) => Listener = this.registerEvent();

	/**
	 * Fires when a user subscribes to a channel.
	 *
	 * @eventListener
	 * @param channel The channel that was subscribed to.
	 * @param user The subscribing user.
	 * @param subInfo Additional information about the subscription.
	 * @param msg The raw message that was received.
	 */
	onSub: (handler: (channel: string, user: string, subInfo: ChatSubInfo, msg: UserNotice) => void)
		=> Listener = this.registerEvent();

	/**
	 * Fires when a user resubscribes to a channel.
	 *
	 * @eventListener
	 * @param channel The channel that was resubscribed to.
	 * @param user The resubscribing user.
	 * @param subInfo Additional information about the resubscription.
	 * @param msg The raw message that was received.
	 */
	onResub: (handler: (channel: string, user: string, subInfo: ChatSubInfo, msg: UserNotice) => void)
		=> Listener = this.registerEvent();

	/**
	 * Fires when a user gifts a subscription to a channel to another user.
	 *
	 * @eventListener
	 * @param channel The channel that was subscribed to.
	 * @param user The user that the subscription was gifted to. The gifting user is defined in `subInfo.gifter`.
	 * @param subInfo Additional information about the subscription.
	 * @param msg The raw message that was received.
	 */
	onSubGift: (handler: (channel: string, user: string, subInfo: ChatSubGiftInfo, msg: UserNotice) => void)
		=> Listener = this.registerEvent();

	/**
	 * Fires when a user gifts random subscriptions to the community of a channel.
	 *
	 * @eventListener
	 * @param channel The channel that was subscribed to.
	 * @param user The gifting user.
	 * @param subInfo Additional information about the community subscription.
	 * @param msg The raw message that was received.
	 */
	onCommunitySub: (handler: (channel: string, user: string, subInfo: ChatCommunitySubInfo, msg: UserNotice) => void)
		=> Listener = this.registerEvent();

	/**
	 * Fires when receiving a whisper from another user.
	 *
	 * @eventListener
	 * @param user The user that sent the whisper.
	 * @param message The message text.
	 * @param msg The raw message that was received.
	 */
	onWhisper: (handler: (user: string, message: string, msg: Whisper) => void) => Listener = this.registerEvent();

	/**
	 * Fires when you tried to execute a command you don't have sufficient permission for.
	 *
	 * @eventListener
	 * @param channel The channel that a command without sufficient permissions was executed on.
	 * @maram message The message text.
	 */
	onNoPermission: (handler: (channel: string, message: string) => void) => Listener = this.registerEvent();

	/**
	 * Fires when authentication fails.
	 *
	 * @eventListener
	 * @param channel The channel that a command without sufficient permissions was executed on.
	 * @maram message The message text.
	 */
	onAuthenticationFailure: (handler: (message: string) => void) => Listener = this.registerEvent();

	// override for specific class
	/**
	 * Fires when a user sends a message to a channel.
	 *
	 * @eventListener
	 * @param channel The channel the message was sent to.
	 * @param user The user that send the message.
	 * @param message The message text.
	 * @param msg The raw message  that was received.
	 */
	onPrivmsg!: (handler: (channel: string, user: string, message: string, msg: TwitchPrivateMessage) => void) => Listener;

	// internal events to resolve promises and stuff
	private readonly _onBanResult: (handler: (channel: string, user: string, error?: string) => void)
		=> Listener = this.registerEvent();
	private readonly _onTimeoutResult:
		(handler: (channel: string, user: string, duration?: number, reason?: string, error?: string) => void)
			=> Listener = this.registerEvent();
	private readonly _onUnbanResult: (handler: (channel: string, user: string, error?: string) => void)
		=> Listener = this.registerEvent();
	private readonly _onColorResult: (handler: (error?: string) => void) => Listener = this.registerEvent();
	private readonly _onCommercialResult: (handler: (channel: string, error?: string) => void) => Listener = this.registerEvent();
	private readonly _onEmoteOnlyResult: (handler: (channel: string, error?: string) => void) => Listener = this.registerEvent();
	private readonly _onEmoteOnlyOffResult: (handler: (channel: string, error?: string) => void) => Listener = this.registerEvent();
	private readonly _onFollowersOnlyResult: (handler: (channel: string, delay?: number, error?: string) => void)
		=> Listener = this.registerEvent();
	private readonly _onFollowersOnlyOffResult: (handler: (channel: string, error?: string) => void)
		=> Listener = this.registerEvent();
	private readonly _onHostResult: (handler: (channel: string, error?: string) => void)
		=> Listener = this.registerEvent();
	private readonly _onUnhostResult: (handler: (channel: string, error?: string) => void) => Listener = this.registerEvent();
	private readonly _onModResult: (handler: (channel: string, user: string, error?: string) => void)
		=> Listener = this.registerEvent();
	private readonly _onUnmodResult: (handler: (channel: string, user: string, error?: string) => void)
		=> Listener = this.registerEvent();
	private readonly _onModsResult: (handler: (channel: string, mods?: string[], error?: string) => void)
		=> Listener = this.registerEvent();
	private readonly _onJoinResult: (handler: (channel: string, state?: Map<string, string>, error?: string) => void)
		=> Listener = this.registerEvent();
	private readonly _onR9kResult: (handler: (channel: string, error?: string) => void) => Listener = this.registerEvent();
	private readonly _onR9kOffResult: (handler: (channel: string, error?: string) => void) => Listener = this.registerEvent();
	private readonly _onSlowResult: (handler: (channel: string, delay?: number, error?: string) => void)
		=> Listener = this.registerEvent();
	private readonly _onSlowOffResult: (handler: (channel: string, error?: string) => void) => Listener = this.registerEvent();
	private readonly _onSubsOnlyResult: (handler: (channel: string, error?: string) => void) => Listener = this.registerEvent();
	private readonly _onSubsOnlyOffResult: (handler: (channel: string, error?: string) => void) => Listener = this.registerEvent();
	private readonly _onIntermediateAuthenticationFailure: (handler: (message: string) => void) => Listener = this.registerEvent();

	/**
	 * Creates a new Twitch chat client with the user info from the TwitchClient instance.
	 *
	 * @expandParams
	 *
	 * @param twitchClient The TwitchClient instance to use for user info and API requests.
	 * @param options
	 */
	static async forTwitchClient(twitchClient: TwitchClient, options: ChatClientOptions = {}) {
		return new this(twitchClient, options);
	}

	/**
	 * Creates a new anonymous Twitch chat client.
	 *
	 * @expandParams
	 *
	 * @param options
	 */
	static anonymous(options: ChatClientOptions = {}) {
		return new this(undefined, options);
	}

	/**
	 * Creates a new Twitch chat client.
	 *
	 * @expandParams
	 *
	 * @param twitchClient The {@TwitchClient} instance to use for API requests.
	 * @param options
	 */
	constructor(
		twitchClient: TwitchClient | undefined,
		options: ChatClientOptions
	) {
		/* eslint-disable no-restricted-syntax */
		super({
			connection: {
				hostName: options.webSocket === false ? 'irc.chat.twitch.tv' : 'irc-ws.chat.twitch.tv',
				secure: options.ssl !== false
			},
			credentials: {
				nick: ''
			},
			webSocket: options.webSocket !== false,
			logLevel: options.logLevel,
			nonConformingCommands: ['004']
		});
		/* eslint-enable no-restricted-syntax */

		this._twitchClient = twitchClient;

		this._useLegacyScopes = !!options.legacyScopes;
		this._readOnly = !!options.readOnly;

		// tslint:disable:no-floating-promises
		this.registerCapability(TwitchTagsCapability);
		this.registerCapability(TwitchCommandsCapability);
		if (options.requestMembershipEvents) {
			this.registerCapability(TwitchMembershipCapability);
		}
		// tslint:enable:no-floating-promises

		// reconnect with refreshed token
		this._onIntermediateAuthenticationFailure(async message => {
			if (this._authRetrying) {
				this._authRetrying = false;
				this._authFailureMessage = message;
				this.emit(this.onAuthenticationFailure, message);
				return;
			}
			this._chatLogger.warning('Token unexpectedly expired; trying to refresh');
			if (this._twitchClient) {
				this._authRetrying = true;
				const newToken = await this._twitchClient.refreshAccessToken();
				if (newToken) {
					this._updateCredentials({
						password: `oauth:${newToken.accessToken}`
					});
					this.quit();
					this._authFailureMessage = undefined;
					await super.connect();
					return;
				}
			}
			this._authRetrying = false;
			this._authFailureMessage = message;
			this.emit(this.onAuthenticationFailure, message);
		});

		this.onMessage(ClearChat, ({ params: { channel, user }, tags }) => {
			if (user) {
				const duration = tags.get('ban-duration');
				const reason = tags.get('ban-reason');
				if (duration === undefined) {
					// ban
					this.emit(this.onBan, channel, user, reason);
				} else {
					// timeout
					this.emit(this.onTimeout, channel, user, reason, Number(duration));
					this.emit(this._onTimeoutResult, channel, user, reason, Number(duration));
				}
			} else {
				// full chat clear
				this.emit(this.onChatClear, channel);
			}
		});

		this.onMessage(HostTarget, ({ params: { channel, targetAndViewers } }) => {
			const [target, viewers] = targetAndViewers.split(' ');
			if (target === '-') {
				// unhost
				this.emit(this.onUnhost, channel);
			} else {
				const numViewers = Number(viewers);
				this.emit(this.onHost, channel, target, isNaN(numViewers) ? undefined : numViewers);
			}
		});

		this.onMessage(ChannelJoin, ({ prefix, params: { channel } }) => {
			this.emit(this.onJoin, channel, prefix!.nick);
		});

		this.onMessage(ChannelPart, ({ prefix, params: { channel } }: ChannelPart) => {
			this.emit(this.onPart, channel, prefix!.nick);
		});

		this.onMessage(TwitchPrivateMessage, ({ prefix, params: { target: channel, message } }) => {
			if (prefix && prefix.nick === 'jtv') {
				// 1 = who hosted
				// 2 = auto-host or not
				// 3 = how many viewers (not always present)
				const match = message.match(ChatClient.HOST_MESSAGE_REGEX);
				if (match) {
					this.emit(this.onHosted, channel, match[1], Boolean(match[2]), match[3] === '' ? undefined : Number(match[3]));
				}
			}
		});

		this.onMessage(RoomState, ({ params: { channel }, tags }) => {
			let isInitial = false;
			if (tags.has('subs-only') && tags.has('slow')) {
				// this is the full state - so we just successfully joined
				this.emit(this._onJoinResult, channel, tags);
				isInitial = true;
			}

			if (tags.has('slow')) {
				const slowDelay = Number(tags.get('slow'));
				if (slowDelay) {
					this.emit(this._onSlowResult, channel, slowDelay);
					if (!isInitial) {
						this.emit(this.onSlow, channel, true, slowDelay);
					}
				} else {
					this.emit(this._onSlowOffResult, channel);
					if (!isInitial) {
						this.emit(this.onSlow, channel, false);
					}
				}
			}

			if (tags.has('followers-only')) {
				const followDelay = Number(tags.get('followers-only'));
				if (followDelay === -1) {
					this.emit(this._onFollowersOnlyOffResult, channel);
					if (!isInitial) {
						this.emit(this.onFollowersOnly, channel, false);
					}
				} else {
					this.emit(this._onFollowersOnlyResult, channel, followDelay);
					if (!isInitial) {
						this.emit(this.onFollowersOnly, channel, true, followDelay);
					}
				}
			}
		});

		this.onMessage(UserNotice, userNotice => {
			const { params: { channel, message }, tags } = userNotice;
			const messageType = tags.get('msg-id');

			switch (messageType) {
				case 'sub':
				case 'resub': {
					const event = messageType === 'sub' ? this.onSub : this.onResub;
					const plan = tags.get('msg-param-sub-plan')!;
					const streakMonths = tags.get('msg-param-streak-months');
					const subInfo: ChatSubInfo = {
						displayName: tags.get('display-name')!,
						plan,
						planName: tags.get('msg-param-sub-plan-name')!,
						isPrime: plan === 'Prime',
						months: Number(tags.get('msg-param-cumulative-months')),
						streak: streakMonths ? Number(streakMonths) : undefined,
						message
					};
					this.emit(event, channel, tags.get('login')!, subInfo, userNotice);
					break;
				}
				case 'subgift':
				case 'anonsubgift': {
					const plan = tags.get('msg-param-sub-plan')!;
					const gifter = tags.get('login');
					const isAnon = messageType === 'anonsubgift' || gifter === 'ananonymousgifter';
					const subInfo: ChatSubGiftInfo = {
						displayName: tags.get('msg-param-recipient-display-name')!,
						gifter: isAnon ? undefined : gifter,
						gifterDisplayName: isAnon ? undefined : tags.get('display-name')!,
						gifterGiftCount: isAnon ? undefined : Number(tags.get('msg-param-sender-count')!),
						plan,
						planName: tags.get('msg-param-sub-plan-name')!,
						isPrime: plan === 'Prime',
						months: Number(tags.get('msg-param-months'))
					};
					this.emit(this.onSubGift, channel, tags.get('msg-param-recipient-user-name')!, subInfo, userNotice);
					break;
				}
				case 'anonsubmysterygift':
				case 'submysterygift': {
					const gifter = tags.get('login');
					const isAnon = messageType === 'anonsubmysterygift' || gifter === 'ananonymousgifter';
					const communitySubInfo: ChatCommunitySubInfo = {
						gifter: isAnon ? undefined : gifter,
						gifterDisplayName: isAnon ? undefined : tags.get('display-name')!,
						gifterGiftCount: isAnon ? undefined : Number(tags.get('msg-param-sender-count')!),
						count: Number(tags.get('msg-param-mass-gift-count')!),
						plan: tags.get('msg-param-sub-plan')!
					};
					this.emit(this.onCommunitySub, channel, tags.get('login'), communitySubInfo, userNotice);
					break;
				}
				case 'raid': {
					const raidInfo: ChatRaidInfo = {
						displayName: tags.get('msg-param-displayName')!,
						viewerCount: Number(tags.get('msg-param-viewerCount'))
					};
					this.emit(this.onRaid, channel, tags.get('login')!, raidInfo, userNotice);
					break;
				}
				case 'ritual': {
					const ritualInfo: ChatRitualInfo = {
						ritualName: tags.get('msg-param-ritual-name')!,
						message
					};
					this.emit(this.onRitual, channel, tags.get('login')!, ritualInfo, userNotice);
					break;
				}
				case 'bitsbadgetier': {
					const badgeUpgradeInfo: ChatBitsBadgeUpgradeInfo = {
						displayName: tags.get('display-name')!,
						threshold: Number(tags.get('msg-param-threshold'))
					};
					this.emit(this.onBitsBadgeUpgrade, channel, tags.get('login')!, badgeUpgradeInfo, userNotice);
					break;
				}
				default: {
					// eslint-disable-next-line no-console
					console.warn(`Unrecognized usernotice ID: ${messageType}`);
				}
			}
		});

		this.onMessage(Whisper, whisper => {
			this.emit(this.onWhisper, whisper.prefix!.nick, whisper.params.message, whisper);
		});

		this.onMessage(Notice, ({ params: { target: channel, message }, tags }) => {
			const messageType = tags.get('msg-id');

			// this event handler involves a lot of parsing strings you shouldn't parse...
			// but Twitch doesn't give us the required info in tags (╯°□°）╯︵ ┻━┻
			// (this code also might not do the right thing with foreign character display names...)
			switch (messageType) {
				// ban
				case 'already_banned': {
					const match = message.split(' ');
					const user = (match && /^\w+$/.test(match[0])) ? match[0] : undefined;
					this.emit(this._onBanResult, channel, user, messageType);
					break;
				}

				case 'bad_ban_self': {
					this.emit(this._onBanResult, channel, this._credentials.nick, messageType);
					break;
				}

				case 'bad_ban_broadcaster': {
					this.emit(this._onBanResult, channel, toUserName(channel), messageType);
					break;
				}

				case 'bad_ban_admin':
				case 'bad_ban_global_mod':
				case 'bad_ban_staff': {
					const match = message.match(/^You cannot ban (?:\w+ )+?(\w+)\.$/);
					this.emit(this._onBanResult, channel, match ? match[1].toLowerCase() : undefined, messageType);
					break;
				}

				case 'ban_success': {
					const match = message.split(' ');
					const user = (match && /^\w+$/.test(match[0])) ? match[0] : undefined;
					this.emit(this._onBanResult, channel, user);
					break;
				}

				// unban
				case 'bad_unban_no_ban': {
					const match = message.split(' ');
					const user = (match && /^\w+$/.test(match[0])) ? match[0] : undefined;
					this.emit(this._onUnbanResult, channel, user, messageType);
					break;
				}

				case 'unban_success': {
					const match = message.split(' ');
					const user = (match && /^\w+$/.test(match[0])) ? match[0] : undefined;
					this.emit(this._onUnbanResult, channel, user);
					break;
				}

				// color
				case 'turbo_only_color': {
					this.emit(this._onColorResult, messageType);
					break;
				}

				case 'color_changed': {
					this.emit(this._onColorResult);
					break;
				}

				// commercial
				case 'bad_commercial_error': {
					this.emit(this._onCommercialResult, channel, messageType);
					break;
				}

				case 'commercial_success': {
					this.emit(this._onCommercialResult, channel);
					break;
				}

				// emote only
				case 'already_emote_only_on': {
					this.emit(this._onEmoteOnlyResult, channel, messageType);
					break;
				}

				case 'emote_only_on': {
					this.emit(this._onEmoteOnlyResult, channel);
					this.emit(this.onEmoteOnly, channel, true);
					break;
				}

				// emote only off
				case 'already_emote_only_off': {
					this.emit(this._onEmoteOnlyOffResult, channel, messageType);
					break;
				}

				case 'emote_only_off': {
					this.emit(this._onEmoteOnlyOffResult, channel);
					this.emit(this.onEmoteOnly, channel, false);
					break;
				}

				// host
				case 'bad_host_hosting':
				case 'bad_host_rate_exceeded':
				case 'bad_host_error': {
					this.emit(this._onHostResult, channel, messageType);
					break;
				}

				case 'hosts_remaining': {
					const remainingHostsFromChar = +message[0];
					const remainingHosts = isNaN(remainingHostsFromChar) ? 0 : Number(remainingHostsFromChar);
					this.emit(this._onHostResult, channel);
					this.emit(this.onHostsRemaining, channel, remainingHosts);
					break;
				}

				// unhost (only fails, success is handled by HOSTTARGET)
				case 'not_hosting': {
					this.emit(this._onUnhostResult, channel, messageType);
					break;
				}

				// join (success is handled when ROOMSTATE comes in)
				case 'msg_channel_suspended': {
					this.emit(this._onJoinResult, channel, undefined, messageType);
					break;
				}

				// mod
				case 'bad_mod_banned':
				case 'bad_mod_mod': {
					const match = message.split(' ');
					const user = (match && /^\w+$/.test(match[0])) ? match[0] : undefined;
					this.emit(this._onModResult, channel, user, messageType);
					break;
				}

				case 'mod_success': {
					const match = message.match(/^You have added (\w+) /);
					this.emit(this._onModResult, channel, match ? match[1] : undefined);
					break;
				}

				// unmod
				case 'bad_unmod_mod': {
					const match = message.split(' ');
					const user = (match && /^\w+$/.test(match[0])) ? match[0] : undefined;
					this.emit(this._onUnmodResult, channel, user, messageType);
					break;
				}

				case 'unmod_success': {
					const match = message.match(/^You have removed (\w+) /);
					this.emit(this._onUnmodResult, channel, match ? match[1] : undefined);
					break;
				}

				// mods
				case 'no_mods': {
					this.emit(this._onModsResult, channel, []);
					break;
				}

				case 'room_mods': {
					const [, modList] = message.split(': ');
					const mods = modList.split(', ');
					this.emit(this._onModsResult, channel, mods);
					break;
				}

				// r9k
				case 'already_r9k_on': {
					this.emit(this._onR9kResult, channel, messageType);
					break;
				}

				case 'r9k_on': {
					this.emit(this._onR9kResult, channel);
					this.emit(this.onR9k, channel, true);
					break;
				}

				// r9k off
				case 'already_r9k_off': {
					this.emit(this._onR9kOffResult, channel, messageType);
					break;
				}

				case 'r9k_off': {
					this.emit(this._onR9kOffResult, channel);
					this.emit(this.onR9k, channel, false);
					break;
				}

				// subs only
				case 'already_subs_on': {
					this.emit(this._onSubsOnlyResult, channel, messageType);
					break;
				}

				case 'subs_on': {
					this.emit(this._onSubsOnlyResult, channel);
					this.emit(this.onSubsOnly, channel, true);
					break;
				}

				// subs only off
				case 'already_subs_off': {
					this.emit(this._onSubsOnlyOffResult, channel, messageType);
					break;
				}

				case 'subs_off': {
					this.emit(this._onSubsOnlyOffResult, channel);
					this.emit(this.onSubsOnly, channel, false);
					break;
				}

				// timeout (only fails, success is handled by CLEARCHAT)
				case 'bad_timeout_self': {
					this.emit(this._onTimeoutResult, channel, this._credentials.nick, undefined, undefined, messageType);
					break;
				}

				case 'bad_timeout_broadcaster': {
					this.emit(this._onTimeoutResult, channel, toUserName(channel), undefined, undefined, messageType);
					break;
				}

				case 'bad_timeout_admin':
				case 'bad_timeout_global_mod':
				case 'bad_timeout_staff': {
					const match = message.match(/^You cannot ban (?:\w+ )+?(\w+)\.$/);
					this.emit(
						this._onTimeoutResult, channel, match ? match[1].toLowerCase() : undefined,
						undefined, undefined, messageType
					);
					break;
				}

				case 'cmds_available': {
					// do we really care?
					break;
				}

				// there's other messages that show us the following things...
				// ...like ROOMSTATE...
				case 'followers_on':
				case 'followers_on_zero':
				case 'followers_off':
				case 'slow_on':
				case 'slow_off': {
					break;
				}

				// ...and CLEARCHAT...
				case 'timeout_success': {
					break;
				}

				// ...and HOSTTARGET
				case 'host_off':
				case 'host_on':
				case 'host_target_went_offline': {
					break;
				}

				case 'unrecognized_cmd': {
					break;
				}

				case 'no_permission': {
					this.emit(this.onNoPermission, channel, message);
					break;
				}

				case undefined: {
					// this might be one of these weird authentication error notices that don't have a msg-id...
					if (message === 'Login authentication failed'
						|| message === 'Improperly formatted AUTH'
						|| message === 'Invalid NICK') {
						this.emit(this.onAuthenticationFailure, message);
						this._connection.disconnect();
					}
					break;
				}

				default: {
					if (!messageType || messageType.substr(0, 6) !== 'usage_') {
						// eslint-disable-next-line no-console
						console.warn(`Unrecognized notice ID: '${messageType}'`);
					}
				}
			}
		});
	}

	async connect() {
		if (this._twitchClient) {
			let scopes: string[];
			if (this._useLegacyScopes) {
				scopes = ['chat_login'];
			} else if (this._readOnly) {
				scopes = ['chat:read'];
			} else {
				scopes = ['chat:read', 'chat:edit'];
			}
			let validToken = false;
			try {
				const accessToken = await this._twitchClient.getAccessToken(scopes);
				if (accessToken) {
					const token = await this._twitchClient.getTokenInfo();
					if (token.valid) {
						this._updateCredentials({
							nick: token.userName!,
							password: `oauth:${accessToken.accessToken}`
						});
						validToken = true;
					}
				}
			} catch (e) {
				this._chatLogger.err(`Retrieving an access token failed: ${e.message}`);
			}
			if (!validToken) {
				this._chatLogger.warning('No valid token available; trying to refresh');

				try {
					const newToken = await this._twitchClient.refreshAccessToken();

					if (newToken) {
						const token = await this._twitchClient.getTokenInfo();
						if (token.valid) {
							this._updateCredentials({
								nick: token.userName!,
								password: `oauth:${newToken.accessToken}`
							});
							validToken = true;
						}
					}
				} catch (e) {
					this._chatLogger.err(`Refreshing the access token failed: ${e.message}`);
				}
			}

			if (!validToken) {
				throw new Error('Could not retrieve a valid token');
			}
		} else {
			this._updateCredentials({
				nick: ChatClient._generateJustinfanNick(),
				password: undefined
			})
		}

		await super.connect();
	}

	/**
	 * Hosts a channel on another channel.
	 *
	 * @param target The host target, i.e. the channel that is being hosted.
	 * @param channel The host source, i.e. the channel that is hosting. Defaults to the channel of the connected user.
	 */
	async host(target: string, channel: string = this._credentials.nick) {
		channel = toUserName(channel);
		return new Promise<void>((resolve, reject) => {
			const e = this._onHostResult((chan, error) => {
				if (toUserName(chan) === channel) {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
					this.removeListener(e);
				}
			});
			this.say(channel, `/host ${target}`);
		});
	}

	/**
	 * Ends any host on a channel.
	 *
	 * This only works when in the channel that was hosted in order to provide feedback about success of the command.
	 *
	 * If you don't need this feedback, consider using {@ChatClient#unhostOutside} instead.
	 *
	 * @param channel The channel to end the host on. Defaults to the channel of the connected user.
	 */
	async unhost(channel: string = this._credentials.nick) {
		channel = toUserName(channel);
		return new Promise<void>((resolve, reject) => {
			const e = this._onUnhostResult((chan, error) => {
				if (toUserName(chan) === channel) {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
					this.removeListener(e);
				}
			});
			this.say(channel, '/unhost');
		});
	}

	/**
	 * Ends any host on a channel.
	 *
	 * This works even when not in the channel that was hosted, but provides no feedback about success of the command.
	 *
	 * If you need feedback about success, use {@ChatClient#unhost} (but make sure you're in the channel you are hosting).
	 *
	 * @param channel The channel to end the host on. Defaults to the channel of the connected user.
	 */
	unhostOutside(channel: string = this._credentials.nick) {
		this.say(channel, '/unhost');
	}

	/**
	 * Sends a message to a channel.
	 *
	 * @param channel The channel to send the message to.
	 * @param message The message to send.
	 */
	say(channel: string, message: string) {
		super.say(toChannelName(channel), message);
	}

	/**
	 * Joins a channel.
	 *
	 * @param channel The channel to join.
	 */
	async join(channel: string) {
		channel = toChannelName(channel);
		return new Promise<void>((resolve, reject) => {
			let timer: NodeJS.Timer;
			const e = this._onJoinResult((chan, state, error) => {
				if (chan === channel) {
					clearTimeout(timer);
					if (error) {
						reject(error);
					} else {
						resolve();
					}
					this.removeListener(e);
				}
			});
			timer = setTimeout(
				() => {
					this.removeListener(e);
					reject(new Error(`Did not receive a reply to join ${channel} in time; assuming that the join failed`));
				},
				10000
			);
			super.join(channel);
		});
	}

	/**
	 * Disconnects from the chat server.
	 */
	async quit() {
		return new Promise<void>(resolve => {
			const handler = () => {
				this._connection.removeListener('disconnect', handler);
				resolve();
			};
			this._connection.addListener('disconnect', handler);
			this._connection.disconnect();
		});
	}

	/**
	 * Waits for authentication (or "registration" in IRC terms) to finish.
	 */
	async waitForRegistration() {
		if (this._registered) {
			return;
		}

		if (this._authFailureMessage) {
			throw new Error(`Registration failed. Response from Twitch: ${this._authFailureMessage}`);
		}

		let authListener: Listener | undefined;
		try {
			await Promise.race([
				new Promise<never>((resolve, reject) => {
					authListener = this.onAuthenticationFailure(message => {
						reject(Error(`Registration failed. Response from Twitch: ${message}`));
					});
				}),
				super.waitForRegistration()
			]);
		} finally {
			if (authListener) {
				this.removeListener(authListener);
			}
		}
	}

	protected registerCoreMessageTypes() {
		super.registerCoreMessageTypes();
		this.registerMessageType(TwitchPrivateMessage);
	}

	private static _generateJustinfanNick() {
		const randomSuffix = Math.floor(Math.random() * 100000).toString().padStart(5, '0');
		return `justinfan${randomSuffix}`;
	}
}
