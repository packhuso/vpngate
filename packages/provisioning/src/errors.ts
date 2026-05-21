export class ProvisionError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProvisionError";
  }
}
export const InsufficientCredit = (need: number, have: number) =>
  new ProvisionError(
    "INSUFFICIENT_CREDIT",
    `need ${need} satang, have ${have}`,
  );
export const NoGatewayAvailable = () =>
  new ProvisionError("NO_GATEWAY_AVAILABLE", "no active gateway with capacity");
export const NoIpAvailable = () =>
  new ProvisionError(
    "NO_IP_AVAILABLE",
    "no IP available for the requested sale mode/size",
  );
export const NotFound = (what: string) =>
  new ProvisionError("NOT_FOUND", `${what} not found`);
export const ValidationError = (m: string) =>
  new ProvisionError("VALIDATION_ERROR", m);
