"""LiteLLM callback loaded by litellm-config.yaml for the ChatGPT subscription."""

from litellm.integrations.custom_logger import CustomLogger


class ChatGptSystemMessages(CustomLogger):
    """Claude Code sends system messages mid-conversation, which the ChatGPT
    backend rejects ("System messages are not allowed"); it accepts the same
    content as developer messages, which is what Codex itself sends."""

    async def async_pre_call_deployment_hook(self, kwargs, call_type):
        items = kwargs.get("input")
        if kwargs.get("custom_llm_provider") != "chatgpt" or not isinstance(items, list):
            return None
        return {
            **kwargs,
            "input": [
                {**item, "role": "developer"}
                if isinstance(item, dict) and item.get("role") == "system"
                else item
                for item in items
            ],
        }


chatgpt_system_messages = ChatGptSystemMessages()
