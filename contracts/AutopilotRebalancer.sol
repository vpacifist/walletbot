// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface INonfungiblePositionManager {
    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function decreaseLiquidity(DecreaseLiquidityParams calldata params) external payable returns (uint256 amount0, uint256 amount1);
    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);
    function mint(MintParams calldata params) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
}

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

contract AutopilotRebalancer {
    error NotOwner();
    error NotExecutor();
    error Reentered();
    error Expired();
    error UnsupportedToken();
    error UnsupportedFee();
    error InvalidRecipient();
    error InvalidAmount();
    error TransferFailed();

    struct CloseParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
    }

    struct SwapParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct MintParams {
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
    }

    struct RebalanceParams {
        CloseParams closePosition;
        SwapParams swap;
        MintParams mintPosition;
        uint256 deadline;
    }

    uint24 public constant POOL_FEE = 3000;
    uint128 private constant MAX_UINT128 = type(uint128).max;

    address public immutable owner;
    address public immutable executor;
    address public immutable vault;
    address public immutable weth;
    address public immutable usdc;
    INonfungiblePositionManager public immutable positionManager;
    ISwapRouter02 public immutable swapRouter;

    bool private locked;

    event Rebalanced(
        uint256 indexed closedTokenId,
        uint256 indexed mintedTokenId,
        uint256 swapAmountOut,
        uint128 mintedLiquidity,
        uint256 mintedAmount0,
        uint256 mintedAmount1
    );

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyExecutor() {
        if (msg.sender != executor) revert NotExecutor();
        _;
    }

    modifier nonReentrant() {
        if (locked) revert Reentered();
        locked = true;
        _;
        locked = false;
    }

    constructor(address owner_, address executor_, address vault_, address weth_, address usdc_, address positionManager_, address swapRouter_) {
        if (owner_ == address(0)) revert InvalidRecipient();
        if (executor_ == address(0)) revert InvalidRecipient();
        if (vault_ == address(0)) revert InvalidRecipient();
        owner = owner_;
        executor = executor_;
        vault = vault_;
        weth = weth_;
        usdc = usdc_;
        positionManager = INonfungiblePositionManager(positionManager_);
        swapRouter = ISwapRouter02(swapRouter_);
    }

    function rebalance(RebalanceParams calldata params)
        external
        onlyExecutor
        nonReentrant
        returns (uint256 mintedTokenId, uint128 mintedLiquidity, uint256 swapAmountOut)
    {
        if (block.timestamp > params.deadline) revert Expired();
        _validateTokenPair(params.swap.tokenIn, params.swap.tokenOut);
        _validateMint(params.mintPosition);

        if (params.closePosition.liquidity == 0) revert InvalidAmount();
        positionManager.decreaseLiquidity(
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: params.closePosition.tokenId,
                liquidity: params.closePosition.liquidity,
                amount0Min: params.closePosition.amount0Min,
                amount1Min: params.closePosition.amount1Min,
                deadline: params.deadline
            })
        );

        positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: params.closePosition.tokenId,
                recipient: address(this),
                amount0Max: MAX_UINT128,
                amount1Max: MAX_UINT128
            })
        );

        _approveExact(params.swap.tokenIn, address(swapRouter), params.swap.amountIn);
        swapAmountOut = swapRouter.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: params.swap.tokenIn,
                tokenOut: params.swap.tokenOut,
                fee: POOL_FEE,
                recipient: address(this),
                amountIn: params.swap.amountIn,
                amountOutMinimum: params.swap.amountOutMinimum,
                sqrtPriceLimitX96: params.swap.sqrtPriceLimitX96
            })
        );
        _approveExact(params.swap.tokenIn, address(swapRouter), 0);

        _approveExact(weth, address(positionManager), params.mintPosition.amount0Desired);
        _approveExact(usdc, address(positionManager), params.mintPosition.amount1Desired);
        uint256 mintedAmount0;
        uint256 mintedAmount1;
        (mintedTokenId, mintedLiquidity, mintedAmount0, mintedAmount1) = positionManager.mint(
            INonfungiblePositionManager.MintParams({
                token0: weth,
                token1: usdc,
                fee: POOL_FEE,
                tickLower: params.mintPosition.tickLower,
                tickUpper: params.mintPosition.tickUpper,
                amount0Desired: params.mintPosition.amount0Desired,
                amount1Desired: params.mintPosition.amount1Desired,
                amount0Min: params.mintPosition.amount0Min,
                amount1Min: params.mintPosition.amount1Min,
                recipient: vault,
                deadline: params.deadline
            })
        );
        _approveExact(weth, address(positionManager), 0);
        _approveExact(usdc, address(positionManager), 0);

        _refund(weth);
        _refund(usdc);

        emit Rebalanced(params.closePosition.tokenId, mintedTokenId, swapAmountOut, mintedLiquidity, mintedAmount0, mintedAmount1);
    }

    function sweepToken(address token) external onlyOwner nonReentrant {
        _validateToken(token);
        _refund(token);
    }

    function _validateMint(MintParams calldata mintPosition) private view {
        if (mintPosition.tickLower >= mintPosition.tickUpper) revert InvalidAmount();
        if (mintPosition.amount0Desired == 0 && mintPosition.amount1Desired == 0) revert InvalidAmount();
        _validateToken(weth);
        _validateToken(usdc);
    }

    function _validateTokenPair(address tokenIn, address tokenOut) private view {
        _validateToken(tokenIn);
        _validateToken(tokenOut);
        if (tokenIn == tokenOut) revert UnsupportedToken();
    }

    function _validateToken(address token) private view {
        if (token != weth && token != usdc) revert UnsupportedToken();
    }

    function _approveExact(address token, address spender, uint256 amount) private {
        if (!IERC20(token).approve(spender, amount)) revert TransferFailed();
    }

    function _refund(address token) private {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0 && !IERC20(token).transfer(vault, balance)) revert TransferFailed();
    }
}
