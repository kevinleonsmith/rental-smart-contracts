import { BigInt } from "@graphprotocol/graph-ts";
import {
  TemplateCreated,
  PropertyRegistered,
  AgreementCreated,
  InsuranceAttached,
} from "../generated/RentalAgreementFactory/RentalAgreementFactory";
import { RentalAgreement } from "../generated/templates/RentalAgreement/RentalAgreement";
import { RentalAgreement as RentalAgreementTemplate } from "../generated/templates";
import {
  Template,
  Property,
  Agreement,
  Platform,
} from "../generated/schema";

const PLATFORM_ID = "platform";

// Maps the on-chain AgreementStatus enum (uint8) to a schema string.
function statusLabel(code: i32): string {
  if (code == 0) return "Active";
  if (code == 1) return "Completed";
  if (code == 2) return "Terminated";
  return "Disputed";
}

function platform(): Platform {
  let p = Platform.load(PLATFORM_ID);
  if (p == null) {
    p = new Platform(PLATFORM_ID);
    p.agreementCount = BigInt.zero();
    p.templateCount = BigInt.zero();
    p.propertyCount = BigInt.zero();
    p.totalEscrowed = BigInt.zero();
    p.totalInsurancePremiums = BigInt.zero();
  }
  return p;
}

export function handleTemplateCreated(event: TemplateCreated): void {
  let t = new Template(event.params.templateId.toString());
  t.name = event.params.name;
  t.category = event.params.category;
  t.createdAt = event.block.timestamp;
  t.save();

  let p = platform();
  p.templateCount = p.templateCount.plus(BigInt.fromI32(1));
  p.save();
}

export function handlePropertyRegistered(event: PropertyRegistered): void {
  let prop = new Property(event.params.propertyId.toString());
  prop.owner = event.params.owner;
  prop.name = event.params.name;
  prop.createdAt = event.block.timestamp;
  prop.save();

  let p = platform();
  p.propertyCount = p.propertyCount.plus(BigInt.fromI32(1));
  p.save();
}

export function handleAgreementCreated(event: AgreementCreated): void {
  let addr = event.params.agreement;
  let a = new Agreement(addr.toHexString());
  a.tenant = event.params.tenant;
  a.landlord = event.params.landlord;
  a.propertyId = event.params.propertyId;
  a.property = event.params.propertyId.toString();
  a.status = "Active";
  a.insured = false;
  a.depositReleased = false;
  a.createdAt = event.block.timestamp;
  a.createdTx = event.transaction.hash;
  a.lastUpdated = event.block.timestamp;

  // AgreementFunded is emitted earlier in this same tx (before AgreementCreated),
  // so the dynamic data source cannot backfill it. Read the funded terms and the
  // template directly from the freshly created clone instead.
  let bound = RentalAgreement.bind(addr);
  let details = bound.try_agreement();
  if (!details.reverted) {
    a.totalRent = details.value.getTotalRent();
    a.securityDeposit = details.value.getSecurityDeposit();
    a.platformFee = details.value.getPlatformFee();
    a.status = statusLabel(details.value.getStatus());
    let templateId = details.value.getTemplateId();
    if (Template.load(templateId.toString()) != null) {
      a.template = templateId.toString();
    }
  } else {
    a.totalRent = BigInt.zero();
    a.securityDeposit = BigInt.zero();
    a.platformFee = BigInt.zero();
  }
  a.save();

  // Start indexing this clone's lifecycle events going forward.
  RentalAgreementTemplate.create(addr);

  let p = platform();
  p.agreementCount = p.agreementCount.plus(BigInt.fromI32(1));
  p.totalEscrowed = p.totalEscrowed
    .plus(a.totalRent)
    .plus(a.securityDeposit)
    .plus(a.platformFee);
  p.save();
}

export function handleInsuranceAttached(event: InsuranceAttached): void {
  let a = Agreement.load(event.params.agreement.toHexString());
  if (a == null) return;
  a.insured = true;
  a.insurancePolicyId = event.params.policyId;
  a.insurancePremium = event.params.premium;
  a.lastUpdated = event.block.timestamp;
  a.save();

  let p = platform();
  p.totalInsurancePremiums = p.totalInsurancePremiums.plus(event.params.premium);
  p.save();
}
