package com.shop;

import org.testng.annotations.Test;

public class CheckoutTest {
    @Test(groups = {"smoke"})
    public void payByCard() {}

    @Test(groups = {"regression"})
    public void payByWallet() {}
}
