"""Agent API declarations: the instance's own commands only (`x-kodera-authz` roles: agent)."""

from core.api.scopes import Operation

GET_COMMANDS = Operation(method="GET", operation_id="getCommands", scope="agent")
ACK_COMMAND = Operation(method="POST", operation_id="ackCommand", scope="agent")
REPORT_COMMAND_RESULT = Operation(method="POST", operation_id="reportCommandResult", scope="agent")
