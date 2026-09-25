-- Form 60 on file (the declaration a customer with no PAN gives). Together with clients.panNumber this is what lets a
-- sale above the Rule 114B threshold (₹2,00,000) through. Existing clients: false — nobody has a Form 60 on file
-- until someone records it.
ALTER TABLE "clients" ADD COLUMN "form60Received" BOOLEAN NOT NULL DEFAULT false;
