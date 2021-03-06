import PubSubBitsMessage, { PubSubBitsMessageData } from './PubSubBitsMessage';
import PubSubBitsBadgeUnlockMessage, { PubSubBitsBadgeUnlockMessageData } from './PubSubBitsBadgeUnlockMessage';
import PubSubChatModActionMessage, { PubSubChatModActionMessageData } from './PubSubChatModActionMessage';
import PubSubSubscriptionMessage, { PubSubSubscriptionMessageData } from './PubSubSubscriptionMessage';
import PubSubWhisperMessage, { PubSubWhisperMessageData } from './PubSubWhisperMessage';

export interface PubSubBasicMessageInfo {
	user_name: string;
	channel_name: string;
	user_id: string;
	channel_id: string;
	time: string;
}

export interface PubSubChatMessageEmote {
	start: number;
	end: number;
	id: number;
}

export interface PubSubChatMessageBadge {
	id: string;
	version: string;
}

export interface PubSubChatMessage {
	message: string;
	emotes: PubSubChatMessageEmote[];
}

type PubSubMessageData = PubSubBitsMessageData | PubSubBitsBadgeUnlockMessageData | PubSubChatModActionMessageData | PubSubSubscriptionMessageData | PubSubWhisperMessageData;
export { PubSubMessageData };

type PubSubMessage = PubSubBitsMessage | PubSubBitsBadgeUnlockMessage | PubSubChatModActionMessage | PubSubSubscriptionMessage | PubSubWhisperMessage;
export default PubSubMessage;
