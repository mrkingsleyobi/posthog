import { IconChevronDown, IconDocument, IconInfo } from '@posthog/icons'
import { LemonButton, LemonTag, Link } from '@posthog/lemon-ui'
import clsx from 'clsx'
import { useActions, useValues } from 'kea'
import { BillingUpgradeCTA } from 'lib/components/BillingUpgradeCTA'
import { FEATURE_FLAGS, UNSUBSCRIBE_SURVEY_ID } from 'lib/constants'
import { useResizeBreakpoints } from 'lib/hooks/useResizeObserver'
import { IconChevronRight } from 'lib/lemon-ui/icons'
import { LemonBanner } from 'lib/lemon-ui/LemonBanner'
import { More } from 'lib/lemon-ui/LemonButton/More'
import { Tooltip } from 'lib/lemon-ui/Tooltip'
import { featureFlagLogic } from 'lib/logic/featureFlagLogic'
import { capitalizeFirstLetter, humanFriendlyCurrency } from 'lib/utils'
import { useRef } from 'react'
import { getProductIcon } from 'scenes/products/Products'

import { BillingProductV2AddonType, BillingProductV2Type, BillingTierType, ProductKey } from '~/types'

import { getUpgradeProductLink, summarizeUsage } from './billing-utils'
import { BillingGauge } from './BillingGauge'
import { BillingLimit } from './BillingLimit'
import { billingLogic } from './billingLogic'
import { BillingProductAddon } from './BillingProductAddon'
import { billingProductLogic } from './billingProductLogic'
import { BillingProductPricingTable } from './BillingProductPricingTable'
import { paymentEntryLogic } from './paymentEntryLogic'
import { ProductPricingModal } from './ProductPricingModal'
import { UnsubscribeSurveyModal } from './UnsubscribeSurveyModal'

export const getTierDescription = (
    tiers: BillingTierType[],
    i: number,
    product: BillingProductV2Type | BillingProductV2AddonType,
    interval: string
): string => {
    return i === 0
        ? tiers[i].up_to
            ? `First ${summarizeUsage(tiers[i].up_to)} ${product.unit}s / ${interval}`
            : `All ${product.unit}s`
        : tiers[i].up_to
        ? `${summarizeUsage(tiers?.[i - 1].up_to || null)} - ${summarizeUsage(tiers[i].up_to)}`
        : `> ${summarizeUsage(tiers?.[i - 1].up_to || null)}`
}

export const BillingProduct = ({ product }: { product: BillingProductV2Type }): JSX.Element => {
    const productRef = useRef<HTMLDivElement | null>(null)
    const { billing, redirectPath, isUnlicensedDebug } = useValues(billingLogic)
    const {
        hasCustomLimitSet,
        showTierBreakdown,
        billingGaugeItems,
        isPricingModalOpen,
        currentAndUpgradePlans,
        surveyID,
        billingProductLoading,
        isSessionReplayWithAddons,
    } = useValues(billingProductLogic({ product }))
    const {
        setShowTierBreakdown,
        toggleIsPricingModalOpen,
        reportSurveyShown,
        setSurveyResponse,
        setBillingProductLoading,
    } = useActions(billingProductLogic({ product, productRef }))
    const { featureFlags } = useValues(featureFlagLogic)

    const { upgradePlan, currentPlan } = currentAndUpgradePlans

    const { showPaymentEntryModal } = useActions(paymentEntryLogic)

    const upgradeToPlanKey = upgradePlan?.plan_key
    const currentPlanKey = currentPlan?.plan_key

    const { ref, size } = useResizeBreakpoints({
        0: 'small',
        700: 'medium',
    })

    // Used when a product is offered for free to beta users, so we want to show usage but
    // there is no pricing (aka tiers) and no free_allotment
    const isTemporaryFreeProduct =
        (!product.tiered && !product.free_allocation && !product.inclusion_only) ||
        (product.tiered && product.tiers?.length === 1 && product.tiers[0].unit_amount_usd === '0')

    return (
        <div
            className={clsx('flex flex-wrap max-w-300 pb-8', {
                'flex-col pb-4': size === 'small',
            })}
            ref={ref}
            data-attr={`billing-product-${product.type}`}
        >
            <div className="border border-primary rounded w-full bg-surface-primary" ref={productRef}>
                <div className="border-b border-primary rounded-t p-4">
                    <div className="flex gap-4 items-center justify-between">
                        {getProductIcon(product.name, product.icon_key, 'text-2xl')}
                        <div>
                            <h3 className="font-bold mb-0 flex items-center gap-x-2">
                                {product.name}{' '}
                                {isTemporaryFreeProduct && (
                                    <LemonTag type="highlight">included with your plan</LemonTag>
                                )}
                            </h3>
                            <div>{product.description}</div>
                        </div>
                        <div className="flex grow justify-end gap-x-2 items-center">
                            {product.docs_url && (
                                <LemonButton
                                    icon={<IconDocument />}
                                    size="small"
                                    to={product.docs_url}
                                    className="justify-end"
                                    tooltip="Read the docs"
                                />
                            )}
                            {product.contact_support ? (
                                <>
                                    {product.subscribed && <p className="m-0">Need to manage your plan?</p>}
                                    <LemonButton
                                        type="primary"
                                        to="mailto:sales@posthog.com?subject=Enterprise%20plan%20request"
                                    >
                                        Get in touch
                                    </LemonButton>
                                </>
                            ) : (
                                product.subscribed && (
                                    <More
                                        overlay={
                                            <>
                                                <LemonButton
                                                    fullWidth
                                                    to="https://posthog.com/docs/billing/estimating-usage-costs#how-to-reduce-your-posthog-costs"
                                                >
                                                    Learn how to reduce your bill
                                                </LemonButton>
                                                {billing?.subscription_level === 'custom' &&
                                                    (product.plans?.length > 0 ? (
                                                        <LemonButton
                                                            fullWidth
                                                            onClick={() => {
                                                                setSurveyResponse('$survey_response_1', product.type)
                                                                reportSurveyShown(UNSUBSCRIBE_SURVEY_ID, product.type)
                                                            }}
                                                        >
                                                            Unsubscribe
                                                        </LemonButton>
                                                    ) : (
                                                        <LemonButton
                                                            fullWidth
                                                            to="mailto:sales@posthog.com?subject=Custom%20plan%20unsubscribe%20request"
                                                        >
                                                            Contact support to unsubscribe
                                                        </LemonButton>
                                                    ))}
                                            </>
                                        }
                                    />
                                )
                            )}
                            {surveyID && <UnsubscribeSurveyModal product={product} />}
                        </div>
                    </div>
                </div>
                <div className="px-8 pb-8 sm:pb-0">
                    {product.percentage_usage > 1 && (
                        <LemonBanner className="mt-6" type="error">
                            You have exceeded the {hasCustomLimitSet ? 'billing limit' : 'free tier limit'} for this
                            product.
                        </LemonBanner>
                    )}
                    <div className="sm:flex w-full items-center gap-x-8">
                        {product.contact_support && (!product.subscribed || isUnlicensedDebug) ? (
                            <div className="py-8">
                                {!billing?.has_active_subscription && (
                                    <p className="ml-0">
                                        Every product subsciption comes with free platform features such as{' '}
                                        <b>Multiple projects, Integrations, Apps, and more</b>. Subscribe to one of the
                                        products above to get instant access.
                                    </p>
                                )}
                                <p className="m-0">
                                    Need additional platform and support (aka enterprise) features like <b>SAML SSO</b>,{' '}
                                    <b>advanced permissioning</b>, and more?{' '}
                                    <Link to="mailto:sales@posthog.com?subject=Enterprise%20plan%20request">
                                        Get in touch
                                    </Link>{' '}
                                    for a quick chat.
                                </p>
                            </div>
                        ) : (
                            !isUnlicensedDebug && (
                                <>
                                    {isTemporaryFreeProduct ? (
                                        <div className="grow">
                                            <div className="grow">
                                                <BillingGauge items={billingGaugeItems} product={product} />
                                            </div>
                                            {/* TODO: rms: remove this notice after August 8 2024 */}
                                            {product.type == ProductKey.DATA_WAREHOUSE &&
                                                [
                                                    'free-20240530-beta-users-initial',
                                                    'free-20240813-beta-users-initial',
                                                ].includes(currentPlan?.plan_key || '') &&
                                                new Date() < new Date('2024-09-04') && (
                                                    <LemonBanner type="info" className="mb-6">
                                                        <p>
                                                            Free usage for beta users until September 2, 2024. Then, get
                                                            2 million rows free every month.
                                                        </p>
                                                    </LemonBanner>
                                                )}
                                        </div>
                                    ) : product.tiered ? (
                                        <>
                                            <div className="flex w-full items-center gap-x-8">
                                                {product.subscribed && (
                                                    <LemonButton
                                                        icon={
                                                            showTierBreakdown ? (
                                                                <IconChevronDown />
                                                            ) : (
                                                                <IconChevronRight />
                                                            )
                                                        }
                                                        onClick={() => setShowTierBreakdown(!showTierBreakdown)}
                                                    />
                                                )}
                                                <div className="grow">
                                                    <BillingGauge items={billingGaugeItems} product={product} />
                                                </div>
                                            </div>
                                            {product.subscribed ? (
                                                <div className="flex justify-end gap-8 flex-wrap items-end shrink-0">
                                                    <Tooltip
                                                        title={`The current ${
                                                            billing?.discount_percent ? 'discounted ' : ''
                                                        }amount you have been billed for this ${
                                                            billing?.billing_period?.interval
                                                        } so far. This number updates once daily.`}
                                                    >
                                                        <div className="flex flex-col items-center">
                                                            <div className="font-bold text-3xl leading-7">
                                                                {humanFriendlyCurrency(
                                                                    parseFloat(
                                                                        isSessionReplayWithAddons
                                                                            ? product.current_amount_usd_before_addons ||
                                                                                  '0'
                                                                            : product.current_amount_usd || '0'
                                                                    ) *
                                                                        (1 -
                                                                            (billing?.discount_percent
                                                                                ? billing.discount_percent / 100
                                                                                : 0))
                                                                )}
                                                            </div>
                                                            <span className="text-xs text-secondary">
                                                                {capitalizeFirstLetter(
                                                                    billing?.billing_period?.interval || ''
                                                                )}
                                                                -to-date
                                                            </span>
                                                        </div>
                                                    </Tooltip>
                                                    {product.tiers && (
                                                        <Tooltip
                                                            title={`This is roughly calculated based on your current bill${
                                                                billing?.discount_percent
                                                                    ? ', discounts on your account,'
                                                                    : ''
                                                            } and the remaining time left in this billing period. This number updates once daily.`}
                                                        >
                                                            <div className="flex flex-col items-center justify-end">
                                                                <div className="font-bold text-secondary text-lg leading-5">
                                                                    {humanFriendlyCurrency(
                                                                        parseFloat(
                                                                            product.projected_amount_usd || '0'
                                                                        ) *
                                                                            (1 -
                                                                                (billing?.discount_percent
                                                                                    ? billing.discount_percent / 100
                                                                                    : 0))
                                                                    )}
                                                                </div>
                                                                <span className="text-xs text-secondary">
                                                                    Projected
                                                                </span>
                                                            </div>
                                                        </Tooltip>
                                                    )}
                                                </div>
                                            ) : null}
                                        </>
                                    ) : product.current_amount_usd ? (
                                        <div className="my-8">
                                            <Tooltip
                                                title={`The current amount you will be billed for this ${billing?.billing_period?.interval}.`}
                                            >
                                                <div className="flex flex-col items-center">
                                                    <div className="font-bold text-3xl leading-7">
                                                        {humanFriendlyCurrency(product.current_amount_usd)}
                                                    </div>
                                                    <span className="text-xs text-secondary">
                                                        per {billing?.billing_period?.interval || 'period'}
                                                    </span>
                                                </div>
                                            </Tooltip>
                                        </div>
                                    ) : null}
                                </>
                            )
                        )}
                    </div>
                    {product.price_description ? (
                        <LemonBanner type="info">
                            <span dangerouslySetInnerHTML={{ __html: product.price_description }} />
                        </LemonBanner>
                    ) : null}
                    {/* Table with tiers */}
                    {showTierBreakdown && <BillingProductPricingTable product={product} />}
                    {product.addons?.length > 0 && (
                        <div className="pb-8">
                            <h4 className="my-4">Add-ons</h4>
                            {billing?.subscription_level == 'free' && (
                                <LemonBanner type="warning" className="text-sm mb-4" hideIcon>
                                    <div className="flex justify-between items-center">
                                        <div>
                                            Add-ons are only available on paid plans. Upgrade to access these features.
                                        </div>
                                        {featureFlags[FEATURE_FLAGS.BILLING_PAYMENT_ENTRY_IN_APP] == 'test' ? (
                                            <BillingUpgradeCTA
                                                type="primary"
                                                status="alt"
                                                data-attr="billing-page-addon-cta-upgrade-cta"
                                                disableClientSideRouting
                                                loading={!!billingProductLoading}
                                                onClick={showPaymentEntryModal}
                                            >
                                                Upgrade now
                                            </BillingUpgradeCTA>
                                        ) : (
                                            <BillingUpgradeCTA
                                                to={getUpgradeProductLink({
                                                    product,
                                                    redirectPath,
                                                })}
                                                type="primary"
                                                status="alt"
                                                data-attr="billing-page-addon-cta-upgrade-cta"
                                                disableClientSideRouting
                                                loading={!!billingProductLoading}
                                                onClick={() => setBillingProductLoading(product.type)}
                                            >
                                                Upgrade now
                                            </BillingUpgradeCTA>
                                        )}
                                    </div>
                                </LemonBanner>
                            )}
                            <div className="gap-y-4 flex flex-col">
                                {product.addons
                                    // TODO: enhanced_persons: remove this filter
                                    .filter((addon) => {
                                        if (addon.inclusion_only) {
                                            if (featureFlags[FEATURE_FLAGS.PERSONLESS_EVENTS_NOT_SUPPORTED]) {
                                                return false
                                            }
                                        }
                                        return true
                                    })
                                    .map((addon, i) => {
                                        return <BillingProductAddon key={i} addon={addon} />
                                    })}
                            </div>
                        </div>
                    )}
                </div>
                {!isTemporaryFreeProduct && <BillingLimit product={product} />}
                <FeatureFlagUsageNotice product={product} />
            </div>
            <ProductPricingModal
                modalOpen={isPricingModalOpen}
                onClose={toggleIsPricingModalOpen}
                product={product}
                planKey={product.subscribed ? currentPlanKey : upgradeToPlanKey}
            />
        </div>
    )
}

export const FeatureFlagUsageNotice = ({ product }: { product: BillingProductV2Type }): JSX.Element | null => {
    return product.type === 'feature_flags' ? (
        <div className="p-4 px-8 pb-8 sm:pb-0 border-t border-border">
            <p className="mt-0 ml-0 text-sm text-secondary italic">
                <IconInfo className="mr-1" />
                Questions? Here's{' '}
                <Link to="https://posthog.com/docs/feature-flags/common-questions#billing--usage" className="italic">
                    how we calculate usage
                </Link>{' '}
                for feature flags.
            </p>
        </div>
    ) : null
}
