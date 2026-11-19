import { BigInt } from "@graphprotocol/graph-ts";
import {
  AgreementStatusChanged,
  DeductionRequested,
  DeductionApproved,
  DeductionDisputed,
  DeductionResolved,
  SecurityDepositReleased,
  DisputeRaised,
} from "../generated/templates/RentalAgreement/RentalAgreement";
import { Agreement, Deduction, Dispute } from "../generated/schema";

function statusLabel(code: i32): string {
  if (code == 0) return "Active";
  if (code == 1) return "Completed";
  if (code == 2) return "Terminated";
  return "Disputed";
}

// event.address is the agreement clone, which is also the Agreement entity id.
function deductionId(agreement: string, id: BigInt): string {
  return agreement + "-" + id.toString();
}

export function handleAgreementStatusChanged(event: AgreementStatusChanged): void {
  let a = Agreement.load(event.address.toHexString());
  if (a == null) return;
  a.status = statusLabel(event.params.status);
  a.lastUpdated = event.block.timestamp;
  a.save();
}

export function handleDeductionRequested(event: DeductionRequested): void {
  let agreement = event.address.toHexString();
  let d = new Deduction(deductionId(agreement, event.params.deductionId));
  d.agreement = agreement;
  d.deductionId = event.params.deductionId;
  d.reason = event.params.reason;
  d.amount = event.params.amount;
  d.approved = false;
  d.disputed = false;
  d.resolved = false;
  d.createdAt = event.block.timestamp;
  d.save();
}

export function handleDeductionApproved(event: DeductionApproved): void {
  let d = Deduction.load(
    deductionId(event.address.toHexString(), event.params.deductionId)
  );
  if (d == null) return;
  d.approved = true;
  d.save();
}

export function handleDeductionDisputed(event: DeductionDisputed): void {
  let d = Deduction.load(
    deductionId(event.address.toHexString(), event.params.deductionId)
  );
  if (d == null) return;
  d.disputed = true;
  d.save();
  // The accompanying DisputeRaised event (same tx) records the Dispute entity.
}

export function handleDeductionResolved(event: DeductionResolved): void {
  let d = Deduction.load(
    deductionId(event.address.toHexString(), event.params.deductionId)
  );
  if (d == null) return;
  d.resolved = true;
  d.awardedToLandlord = event.params.toLandlord;
  d.refundedToTenant = event.params.toTenant;
  d.save();
}

export function handleSecurityDepositReleased(event: SecurityDepositReleased): void {
  let a = Agreement.load(event.address.toHexString());
  if (a == null) return;
  a.depositReleased = true;
  a.depositRefunded = event.params.amount;
  a.lastUpdated = event.block.timestamp;
  a.save();
}

export function handleDisputeRaised(event: DisputeRaised): void {
  let agreement = event.address.toHexString();
  let id = agreement + "-" + event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let dispute = new Dispute(id);
  dispute.agreement = agreement;
  dispute.raiser = event.params.raiser;
  dispute.reason = event.params.reason;
  dispute.raisedAt = event.block.timestamp;
  dispute.tx = event.transaction.hash;
  dispute.save();
}
